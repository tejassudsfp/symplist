// A raw WebSocket upgrade probe: it reports the HTTP status the server answers, so a script can tell
// a refusal before the handshake (401, 403) from an accepted connection (101) or a missing endpoint.
// It writes the request on a plain TCP socket and reads the status line itself: Node's HTTP client
// intermittently reports "socket hang up" when a server answers an upgrade request with an error
// status and closes the connection at once, which is how the `ws` gate refuses.
import { randomBytes } from "node:crypto";
import { connect } from "node:net";

const headerToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Sends a WebSocket upgrade request for `url` (http or ws scheme) with extra `headers` and resolves
 * with the status of the answer: `101` when the handshake succeeds (the socket is closed at once),
 * otherwise the HTTP status of the refusal. Rejects when the connection fails, closes before a status
 * line, or nothing answers within `timeoutMs`.
 */
export function upgradeStatus(url, headers = {}, { timeoutMs = 10_000 } = {}) {
  const target = new URL(url.replace(/^ws/, "http"));
  const port = Number(target.port || 80);
  const lines = [
    `GET ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (!headerToken.test(name) || /[\r\n]/.test(String(value))) {
      throw new TypeError(`Invalid header ${JSON.stringify(name)}`);
    }
    lines.push(`${name}: ${value}`);
  }

  return new Promise((settle, fail) => {
    let received = "";
    let done = false;
    const finish = (error, status) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (error) fail(error);
      else settle(status);
    };
    const socket = connect({ host: target.hostname, port }, () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.setTimeout(timeoutMs, () => finish(new Error("no answer to the upgrade request")));
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      const lineEnd = received.indexOf("\r\n");
      if (lineEnd === -1) return;
      const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(received.slice(0, lineEnd));
      if (match) finish(undefined, Number(match[1]));
      else finish(new Error(`not an HTTP response: ${JSON.stringify(received.slice(0, lineEnd))}`));
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("the connection closed before a response")));
  });
}
