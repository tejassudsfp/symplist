import type { IncomingMessage } from "node:http";
import { Inject } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import {
  decodeClientFrame,
  userTopic,
  wsClientFrameRateLimit,
  wsCloseCodes,
  wsHeartbeatIntervalMs,
  wsMaxPayloadBytes,
  wsPath,
} from "@symplist/contracts";
import type { RawData, WebSocket, WebSocketServer as WsServer } from "ws";
import {
  errorCode,
  nestOperationalLog,
  type OperationalLog,
  type RuntimeTimers,
  systemTimers,
} from "../../infra/scheduler/runtime.ts";
import { AccessSweep } from "./access-sweep.ts";
import { REALTIME_DEPENDENCIES, type RealtimeDependencies } from "./realtime.tokens.ts";
import { type RealtimeSocketState, type SubscribeOutcome, TopicHub } from "./topic-hub.ts";
import { RealtimeUpgradeGate } from "./upgrade-gate.ts";

const OPEN = 1;
const CLOSED = 3;

interface LiveSocket {
  readonly state: RealtimeSocketState;
  alive: boolean;
  frames: number[];
  /** Frames are handled strictly in arrival order, so `sub` then `unsub` can never reorder. */
  queue: Promise<void>;
}

/**
 * `wss://<api>/v1/ws` (§7). Upgrades are authenticated by `AuthWsAdapter`; the socket carries events
 * plus `sub`, `unsub` and `ping`. More than 20 client frames per 10 seconds or more than 50
 * subscriptions closes with 1008. The server pings every 30 seconds and terminates sockets that
 * missed the previous ping. Shutdown is driven by the platform's `ShutdownCoordinator` through
 * `REALTIME_SHUTDOWN`: {@link stopAccepting}, then {@link closeAll} with 1001, before HTTP drains.
 */
@SkipThrottle()
@WebSocketGateway({ path: wsPath, maxPayload: wsMaxPayloadBytes })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: WsServer;

  private readonly live = new WeakMap<WebSocket, LiveSocket>();
  private heartbeat: unknown;
  private readonly timers: RuntimeTimers;
  private readonly log: OperationalLog;

  constructor(
    @Inject(TopicHub) private readonly hub: TopicHub,
    @Inject(RealtimeUpgradeGate) private readonly gate: RealtimeUpgradeGate,
    @Inject(AccessSweep) private readonly sweep: AccessSweep,
    @Inject(REALTIME_DEPENDENCIES) private readonly dependencies: RealtimeDependencies,
  ) {
    this.timers = dependencies.timers ?? systemTimers;
    this.log = dependencies.log ?? nestOperationalLog("RealtimeGateway");
  }

  afterInit(server: WsServer): void {
    this.server = server;
    if (this.dependencies.backgroundLoops === false) return;
    this.heartbeat = this.timers.setInterval(
      () => this.beat(),
      this.dependencies.tuning?.heartbeatIntervalMs ?? wsHeartbeatIntervalMs,
    );
    this.sweep.start();
  }

  handleConnection(client: WebSocket, request: IncomingMessage): void {
    const verified = this.gate.take(request);
    if (!verified) {
      client.close(wsCloseCodes.sessionEnded, "session required");
      return;
    }
    if (this.hub.isShuttingDown) {
      client.close(wsCloseCodes.goingAway, "server restarting");
      return;
    }
    const session = verified.session;
    const stale = this.hub.staleUpgrade(session, verified.verifiedAt);
    if (stale !== null) {
      client.close(stale, stale === wsCloseCodes.accessLost ? "access changed" : "session ended");
      return;
    }
    const state = this.hub.connect(
      {
        send: (text) => client.send(text),
        close: (code, reason) => client.close(code, reason),
        isOpen: () => client.readyState === OPEN,
      },
      session,
    );
    const live: LiveSocket = { state, alive: true, frames: [], queue: Promise.resolve() };
    this.live.set(client, live);
    client.on("pong", () => {
      live.alive = true;
    });
    client.on("message", (data: RawData, isBinary: boolean) => {
      if (!this.withinRate(live)) return;
      live.queue = live.queue
        .then(() => this.onFrame(client, live, data, isBinary))
        .catch((error: unknown) => {
          this.log.error("realtime.frame_failed", { socketId: state.id, code: errorCode(error) });
        });
    });
    client.once("close", () => this.hub.disconnect(state));
  }

  handleDisconnect(client: WebSocket): void {
    const live = this.live.get(client);
    if (live) this.hub.disconnect(live.state);
  }

  /**
   * Refuses every later upgrade and stops publishing, relaying and the background heartbeat and sweep.
   * Idempotent.
   */
  stopAccepting(): void {
    this.gate.close();
    this.hub.beginShutdown();
    this.sweep.stop();
    if (this.heartbeat !== undefined) this.timers.clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /**
   * Closes every socket with `code` and resolves once all closed or the grace period passed, the
   * shorter of `timeoutMs` and the tuned `shutdownGraceMs`. The grace runs on real time: a client that
   * never answers the close handshake must not hold shutdown, whatever clock drives the gateway.
   */
  async closeAll(code: 1001, timeoutMs: number): Promise<void> {
    this.stopAccepting();
    const clients = [...(this.server?.clients ?? [])];
    if (clients.length === 0) return;
    const closing = clients.map(
      (client) =>
        new Promise<void>((resolve) => {
          if (client.readyState === CLOSED) {
            resolve();
            return;
          }
          client.once("close", () => resolve());
          const live = this.live.get(client);
          if (live) this.hub.disconnect(live.state);
          client.close(code, "server restarting");
        }),
    );
    const graceMs = Math.min(timeoutMs, this.dependencies.tuning?.shutdownGraceMs ?? timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(closing),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    for (const client of clients) {
      if (client.readyState !== CLOSED) client.terminate();
    }
  }

  private beat(): void {
    for (const client of this.server?.clients ?? []) {
      const live = this.live.get(client);
      if (!live) continue;
      if (!live.alive) {
        this.hub.disconnect(live.state);
        client.terminate();
        continue;
      }
      live.alive = false;
      try {
        client.ping();
      } catch {
        this.hub.disconnect(live.state);
        client.terminate();
      }
    }
  }

  /** Counts a client frame on arrival; more than 20 in 10 seconds closes the socket with 1008. */
  private withinRate(live: LiveSocket): boolean {
    if (!this.hub.isConnected(live.state)) return false;
    const now = this.timers.now();
    const windowMs = this.dependencies.tuning?.frameWindowMs ?? wsClientFrameRateLimit.windowMs;
    const limit = this.dependencies.tuning?.framesPerWindow ?? wsClientFrameRateLimit.frames;
    live.frames = live.frames.filter((at) => now - at < windowMs);
    live.frames.push(now);
    if (live.frames.length <= limit) return true;
    this.log.warn("realtime.frame_rate_exceeded", { socketId: live.state.id });
    this.hub.close(live.state, wsCloseCodes.policyViolation, "too many frames");
    return false;
  }

  private async onFrame(
    client: WebSocket,
    live: LiveSocket,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (!this.hub.isConnected(live.state)) return;
    if (isBinary) {
      this.sendError(client, "validation");
      return;
    }
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data as ArrayBuffer).toString("utf8");
    const decoded = decodeClientFrame(text);
    if (!decoded.ok) {
      this.sendError(client, "validation");
      return;
    }
    const frame = decoded.frame;
    switch (frame.t) {
      case "ping":
        if (client.readyState === OPEN) client.send(JSON.stringify({ t: "pong" }));
        return;
      case "unsub":
        this.hub.unsubscribe(live.state, frame.topic);
        return;
      case "sub": {
        const outcome: SubscribeOutcome =
          frame.topic === userTopic
            ? await this.hub.subscribeUser(live.state, "openTasks" in frame ? frame.openTasks : [])
            : await this.hub.subscribeConversation(live.state, frame.topic, frame.cursor);
        if (outcome === "limit") {
          this.log.warn("realtime.subscription_limit", { socketId: live.state.id });
          this.hub.close(live.state, wsCloseCodes.policyViolation, "too many subscriptions");
        } else if (outcome === "not_found") {
          this.sendError(client, "not_found");
        }
        return;
      }
    }
  }

  private sendError(client: WebSocket, code: "validation" | "not_found"): void {
    if (client.readyState === OPEN) client.send(JSON.stringify({ t: "err", code }));
  }
}
