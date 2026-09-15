import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";

/** A server frame as the client received it (§7). */
export interface WsFrame {
  readonly t: string;
  readonly [key: string]: unknown;
}

/**
 * A real WebSocket client for api tests (Node's global `WebSocket`, which accepts headers): records
 * every server frame and the close code, and waits for frames without consuming them.
 */
export class WsTestClient {
  readonly frames: WsFrame[] = [];
  /** Resolves with the close code and reason once the socket closed. */
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  private readonly listeners = new Set<() => void>();

  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.frames.push(JSON.parse(String(event.data)) as WsFrame);
      for (const listener of [...this.listeners]) listener();
    });
    this.closed = new Promise((resolve) => {
      socket.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason }),
      );
    });
  }

  /** Opens a socket and resolves once it is open; rejects when the upgrade is refused. */
  static connect(url: string, headers: Readonly<Record<string, string>>): Promise<WsTestClient> {
    // Node's WebSocket takes `{ headers }` in place of protocols.
    const socket = new WebSocket(url, { headers } as unknown as string[]);
    const client = new WsTestClient(socket);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(client));
      socket.addEventListener("close", () => reject(new Error("closed before open")));
    });
  }

  send(frame: unknown): void {
    this.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** Resolves with the first frame (seen or future) matching `predicate`. */
  waitFor(predicate: (frame: WsFrame) => boolean, timeoutMs = 2_000): Promise<WsFrame> {
    const found = this.frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const check = () => {
        const frame = this.frames.find(predicate);
        if (!frame) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`No matching frame; received ${JSON.stringify(this.frames)}`));
      }, timeoutMs);
      this.listeners.add(check);
    });
  }

  /** Round-trips a ping, so every earlier server frame has arrived. */
  async settle(): Promise<void> {
    const pongs = () => this.frames.filter((frame) => frame.t === "pong").length;
    const before = pongs();
    this.send({ t: "ping" });
    await this.waitFor(() => pongs() > before);
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * A raw upgrade request, to observe the HTTP status of a refused upgrade (and its headers), or to act
 * as a client that never answers pings or close frames.
 */
export function rawUpgrade(
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly socket?: Socket;
}> {
  const target = new URL(url.replace(/^ws/, "http"));
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
        ...headers,
      },
    });
    request.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, headers: response.headers });
    });
    request.on("upgrade", (response, socket) =>
      resolve({ status: response.statusCode ?? 0, headers: response.headers, socket }),
    );
    request.on("error", reject);
    request.end();
  });
}
