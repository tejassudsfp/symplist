/**
 * The loopback MCP relay: the one component that sits between the DeepSeek Harness and the cloud's
 * `/mcp` endpoint.
 *
 * It exists because something has to, and once it exists three problems get easy at once.
 *
 * **The bearer stays out of the harness.** `dsh-acp` takes MCP headers in the `session/new` payload,
 * which crosses stdio in plaintext and lands in a process that has been handed a shell. What crosses
 * instead is this relay's URL and a per-launch capability token, which is worthless after a restart and
 * can only reach a listener bound to 127.0.0.1. Putting the `sym_…` key in those headers would be one
 * "simplification" away, and it is the same shape of mistake as removing a transcript storage to make an
 * agent simpler: it works, and it quietly moves a durable credential somewhere it should never be.
 *
 * **Pacing lives in one place.** The api's D1 lane is 2 req/s with a burst of 10 and a 5-second queue,
 * past which it throws. One MCP tool call costs roughly three D1 requests — the key's row read, the
 * tool's own batch, and the `grants.require` recheck `documentCall` performs *after* the work so content
 * is never returned on stale authority. That is about 0.67 tool calls per second sustained, and a harness
 * that fans out subagents would blow straight through it. One in-flight forwarded request keeps the agent
 * inside the burst window without a single retry, and retries are deliberately not here: the write tools
 * take a `requestId` precisely so an exact retry is safe, but adding backoff before a measured trace says
 * it is needed is how a rate limit becomes a thundering herd.
 *
 * **A 401 becomes one event instead of N stack traces.** Without a relay, a revoked grant reaches the
 * user as a tool failure repeated in the model's context until the turn gives up.
 *
 * It is a forwarder, not an MCP server. It does not implement the protocol, does not filter tools, and
 * never alters a body in either direction — it reads the response only to classify a failure, and the
 * bytes the harness receives are the bytes the cloud sent. This is only viable because the harness's MCP
 * client (sdk 1.30.0) interoperates with the cloud's 2.0 stateless handler as-is: `initialize`,
 * `tools/list` (17 tools) and `tools/call` all succeed, and the SSE `GET` and session-terminating
 * `DELETE` that the 1.x transport may attempt are answered `405` and tolerated. If that ever stops being
 * true, this file has to become a real MCP server and the design roughly doubles in cost.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MainLog } from "../log.ts";
import {
  type RelayFailure,
  relayAdmission,
  relayCapabilityHeader,
  statusFailure,
  toolResultFailure,
} from "./policy.ts";

export interface RelayOptions {
  /** `${API_ORIGIN}/mcp`. The relay never talks to anything else. */
  readonly target: string;
  /** The bearer for the next forwarded request, or `null` when there is no usable grant. */
  readonly bearer: () => string | null;
  /** Told about every failure worth a user-facing state; see `policy.ts` for what each one means. */
  readonly onFailure: (failure: Exclude<RelayFailure, null>) => void;
  readonly log: MainLog;
  readonly fetchImpl?: typeof fetch;
}

/** A running relay: where the harness points, and the token that lets it in. */
export interface McpRelay {
  /** `http://127.0.0.1:<port>/mcp` — safe to put in an ACP payload; it is useless without the token. */
  readonly url: string;
  /** The per-launch capability token, regenerated on every start. Also safe to put in an ACP payload. */
  readonly capability: string;
  stop(): Promise<void>;
}

/** Bodies larger than this are refused rather than buffered: nothing the harness sends is this big. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function startMcpRelay(options: RelayOptions): Promise<McpRelay> {
  const capability = randomBytes(32).toString("base64url");
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  /*
   * One in-flight forwarded request, as a promise chain rather than a queue object: the tail is the only
   * state a serializer needs, and `void`-ing the rejection keeps one failed forward from poisoning the
   * chain for every call behind it.
   */
  let tail: Promise<void> = Promise.resolve();
  const serialize = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release: () => void = () => undefined;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
    }
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const admission = relayAdmission(
      { method: request.method, url: request.url, headers: request.headers },
      capability,
    );
    if (admission.kind === "refuse") {
      options.log.warn("mcp.relay_refused", { reason: admission.reason, status: admission.status });
      response.writeHead(admission.status).end();
      return;
    }
    const bearer = options.bearer();
    if (bearer === null) {
      // No usable grant. Answering 401 here rather than forwarding gives the harness the same startup
      // failure a revoked key would, which is the state the app already knows how to show.
      options.onFailure("invalid_token");
      response.writeHead(401).end();
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(request);
    } catch {
      response.writeHead(413).end();
      return;
    }
    try {
      await serialize(() => forward(body, bearer, request, response));
    } catch (error) {
      // The cloud was unreachable. Nothing about the request is logged — not the body, not the header.
      options.log.error("mcp.relay_forward_failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
      if (!response.headersSent) response.writeHead(502).end();
      else response.end();
    }
  }

  async function forward(
    body: Buffer,
    bearer: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    /*
     * The header set is built, never copied. The capability token is dropped here — it authorizes the
     * hop that just happened and means nothing to the cloud — and no `Origin` is set: `/mcp` is route
     * class `mcp`, whose `allowlisted_if_present` check refuses any Origin that is not WEB_ORIGIN or
     * API_ORIGIN, and the MCP framework's own validator passes a request that has none. That is exactly
     * why a page in the renderer could never call `/mcp` directly even if it held the key.
     */
    const upstream = await fetchImpl(options.target, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: headerOf(request, "accept") ?? "application/json, text/event-stream",
        ...protocolVersion(request),
      },
      // A `Uint8Array` view rather than the Buffer itself: `BodyInit` does not admit a Node Buffer, and
      // the bytes must go out exactly as they came in — a re-serialized JSON body is not the same request.
      body: new Uint8Array(body),
    });
    const failure = statusFailure(upstream.status);
    if (failure) options.onFailure(failure);

    /*
     * The answer may be JSON or an SSE stream, depending on the endpoint's `responseMode`, so the body is
     * relayed as bytes and the content type is carried over untouched. Reading it to classify a tool-level
     * failure means buffering, which costs nothing at these sizes and is worth one honest trade: a tool
     * error arrives as HTTP 200 with `isError` set, so without this read a revoked grant mid-session and a
     * spent read quota would both be invisible to the app.
     */
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (upstream.status === 200) {
      const toolFailure = toolResultFailure(bytes.toString("utf8"));
      if (toolFailure) options.onFailure(toolFailure);
    }
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "content-length": String(bytes.byteLength),
    });
    response.end(bytes);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback only. A relay on 0.0.0.0 would be a credential-bearing proxy exposed to the network.
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("mcp relay: the loopback listener reported no address");
  }
  const url = `http://127.0.0.1:${address.port}/mcp`;
  options.log.info("mcp.relay_started", { port: address.port });
  return {
    url,
    capability,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : value?.[0];
}

/**
 * The harness's client negotiates a protocol revision and then sends `MCP-Protocol-Version` on every
 * later request. Dropping it would make the cloud fall back to a default revision mid-conversation, so it
 * is the one request header carried through — by name, not by copying the request's header bag.
 */
function protocolVersion(request: IncomingMessage): Record<string, string> {
  const value = headerOf(request, "mcp-protocol-version");
  return value === undefined ? {} : { "mcp-protocol-version": value };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("mcp relay: request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Re-exported so the ACP session builder and the relay cannot disagree about the header's name. */
export { relayCapabilityHeader };
