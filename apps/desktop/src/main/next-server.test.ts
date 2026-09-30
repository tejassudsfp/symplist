import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silentMainLog } from "./log.ts";
import {
  reserveLoopbackPort,
  resolveStandaloneEntry,
  startRendererServer,
  waitForHttpReady,
} from "./next-server.ts";

const servers: { close(callback: () => void): void }[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

describe("resolveStandaloneEntry", () => {
  it("prefers the monorepo layout Next emits and falls back to a flat one", () => {
    const monorepo = mkdtempSync(join(tmpdir(), "symplist-standalone-"));
    mkdirSync(join(monorepo, "apps", "web"), { recursive: true });
    writeFileSync(join(monorepo, "apps", "web", "server.js"), "");
    writeFileSync(join(monorepo, "server.js"), "");
    expect(resolveStandaloneEntry(monorepo)).toBe(join(monorepo, "apps", "web", "server.js"));

    const flat = mkdtempSync(join(tmpdir(), "symplist-standalone-"));
    writeFileSync(join(flat, "server.js"), "");
    expect(resolveStandaloneEntry(flat)).toBe(join(flat, "server.js"));
  });

  it("returns null when the web build was never staged", () => {
    expect(resolveStandaloneEntry(mkdtempSync(join(tmpdir(), "symplist-standalone-")))).toBeNull();
  });
});

describe("reserveLoopbackPort", () => {
  it("returns a port that is free at the moment it is handed back", async () => {
    const port = await reserveLoopbackPort();
    expect(port).toBeGreaterThan(0);
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  });
});

describe("waitForHttpReady", () => {
  it("resolves on any answer, including the /signin redirect a signed-out desktop gets", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(307, { location: "/signin" });
      response.end();
    });
    servers.push(server);
    const port = await reserveLoopbackPort();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    await expect(waitForHttpReady(`http://127.0.0.1:${port}`)).resolves.toBeUndefined();
  });

  it("gives up with the origin in the message when nothing ever listens", async () => {
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    await expect(waitForHttpReady(origin, { timeoutMs: 30, intervalMs: 5 })).rejects.toThrow(
      origin,
    );
  });
});

describe("startRendererServer", () => {
  it("refuses to start, and says which command stages the build, when nothing is staged", async () => {
    const empty = mkdtempSync(join(tmpdir(), "symplist-standalone-"));
    await expect(startRendererServer({ root: empty, log: silentMainLog })).rejects.toThrow(
      /build:web/,
    );
  });

  it("boots the staged entry point, reports its origin and stops it", async () => {
    // A stand-in for Next's standalone server: the contract between main and that file is only PORT,
    // HOSTNAME and "answers HTTP", so a four-line server exercises all of it.
    const root = mkdtempSync(join(tmpdir(), "symplist-standalone-"));
    writeFileSync(
      join(root, "server.js"),
      [
        "const { createServer } = require('node:http');",
        "createServer((_request, response) => { response.writeHead(200); response.end('ok'); })",
        "  .listen(Number(process.env.PORT), process.env.HOSTNAME);",
      ].join("\n"),
    );

    const server = await startRendererServer({ root, log: silentMainLog, timeoutMs: 15_000 });
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(server.origin);
      expect(await response.text()).toBe("ok");
    } finally {
      await server.stop();
    }
    await expect(fetch(server.origin)).rejects.toThrow();
  }, 30_000);
});
