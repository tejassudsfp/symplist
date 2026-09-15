import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { upgradeStatus } from "./lib/websocket-upgrade.mjs";

/** A server whose upgrade answer depends on the Origin and Cookie headers, like the api's gate. */
let server;
let base;
const seen = [];

before(async () => {
  server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    seen.push(req.headers);
    if (req.url === "/silent") return;
    if (req.url === "/hang-up") return void socket.destroy();
    if (req.url === "/garbage") return void socket.end("SSH-2.0-OpenSSH\r\n");
    if (req.url === "/ws-abort") {
      // How the ws library refuses a handshake: the whole response, then an immediate destroy.
      socket.once("finish", socket.destroy);
      return void socket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 12\r\n\r\nUnauthorized",
      );
    }
    if (req.url !== "/v1/ws")
      return void socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    if (req.headers.origin !== "http://localhost:3000") {
      return void socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    }
    if (!req.headers.cookie) {
      return void socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    }
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  await new Promise((settle) => server.listen(0, "127.0.0.1", settle));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((settle) => server.close(settle));
});

describe("WebSocket upgrade probe", () => {
  it("reports refusals before the handshake by status", async () => {
    assert.equal(await upgradeStatus(`${base}/v1/ws`, { Origin: "http://localhost:3000" }), 401);
    assert.equal(await upgradeStatus(`${base}/v1/ws`, { Origin: "https://attacker.example" }), 403);
    assert.equal(
      await upgradeStatus(`${base}/elsewhere`, { Origin: "http://localhost:3000" }),
      404,
    );
  });

  it("reads the refusal the ws library writes before destroying the socket, every time", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assert.equal(
        await upgradeStatus(`${base}/ws-abort`, { Origin: "http://localhost:3000" }),
        401,
      );
    }
  });

  it("reports 101 when the handshake succeeds, and accepts ws URLs", async () => {
    const status = await upgradeStatus(`${base.replace("http", "ws")}/v1/ws`, {
      Origin: "http://localhost:3000",
      Cookie: "sym_session=x",
    });
    assert.equal(status, 101);
    const last = seen.at(-1);
    assert.equal(last.upgrade, "websocket");
    assert.equal(last["sec-websocket-version"], "13");
    assert.equal(Buffer.from(last["sec-websocket-key"], "base64").length, 16);
  });

  it("rejects when the server never answers", async () => {
    await assert.rejects(upgradeStatus(`${base}/silent`, {}, { timeoutMs: 200 }), /no answer/);
  });

  it("rejects a connection closed before a status line, and a response that is not HTTP", async () => {
    await assert.rejects(upgradeStatus(`${base}/hang-up`), /closed before a response/);
    await assert.rejects(upgradeStatus(`${base}/garbage`), /not an HTTP response/);
  });

  it("refuses header names and values that would inject request lines", () => {
    assert.throws(() => upgradeStatus(`${base}/v1/ws`, { Origin: "x\r\nCookie: a=b" }), TypeError);
    assert.throws(() => upgradeStatus(`${base}/v1/ws`, { "Bad Header": "x" }), TypeError);
  });

  it("rejects when nothing listens", async () => {
    const closed = createServer();
    await new Promise((settle) => closed.listen(0, "127.0.0.1", settle));
    const { port } = closed.address();
    await new Promise((settle) => closed.close(settle));
    await assert.rejects(upgradeStatus(`http://127.0.0.1:${port}/v1/ws`), /ECONNREFUSED/);
  });
});
