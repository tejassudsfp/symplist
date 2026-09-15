import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runDev } from "./lib/dev-runner.mjs";

/** Small programs standing in for tsc, the api, next dev and trigger dev. */
const fixtures = {
  "exit.mjs": `
    console.log("run " + process.argv[2]);
    process.exitCode = Number(process.argv[3] ?? 0);
  `,
  "service.mjs": `
    // argv: name, readyDelayMs, then optional "exit-after:<ms>:<code>" or "print:<text>"
    const [name, readyDelay = "0", extra = ""] = process.argv.slice(2);
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => { console.log(name + " got " + signal); process.exit(0); });
    }
    setInterval(() => {}, 1000);
    setTimeout(() => {
      if (extra.startsWith("print:")) console.log(extra.slice(6));
      else console.log(name + " READY");
      if (extra.startsWith("exit-after:")) {
        const [, ms, code] = extra.split(":");
        setTimeout(() => process.exit(Number(code)), Number(ms));
      }
    }, Number(readyDelay));
  `,
  "stubborn.mjs": `
    process.on("SIGTERM", () => console.log("stubborn ignores SIGTERM"));
    process.on("SIGINT", () => console.log("stubborn ignores SIGINT"));
    setInterval(() => {}, 1000);
    console.log("stubborn READY");
  `,
  "parent.mjs": `
    import { spawn } from "node:child_process";
    import { existsSync } from "node:fs";
    const pidFile = process.argv[2];
    // The grandchild ignores SIGTERM and records its pid once that handler is installed.
    const source = "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
    spawn(process.execPath, ["-e", source, pidFile], { stdio: "ignore" });
    process.on("SIGTERM", () => process.exit(0));
    const waiting = setInterval(() => {
      if (!existsSync(pidFile)) return;
      clearInterval(waiting);
      console.log("parent READY");
    }, 10);
    setInterval(() => {}, 1000);
  `,
  "http.mjs": `
    import { createServer } from "node:http";
    let requests = 0;
    createServer((req, res) => {
      requests += 1;
      res.statusCode = requests < 3 ? 503 : 200;
      res.end();
    }).listen(Number(process.argv[2]), "127.0.0.1", () => console.log("listening"));
    process.on("SIGTERM", () => process.exit(0));
  `,
};

let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), "symplist-dev-runner-"));
  for (const [name, source] of Object.entries(fixtures)) writeFileSync(join(root, name), source);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function capture() {
  let text = "";
  return {
    stream: {
      isTTY: false,
      write(chunk) {
        text += chunk;
        return true;
      },
    },
    get text() {
      return text;
    },
    async waitFor(pattern, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!pattern.test(text)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}\n${text}`);
        await new Promise((settle) => setTimeout(settle, 20));
      }
    },
  };
}

const node = (name, script, args, extra = {}) => ({
  name,
  tool: "node",
  args: [script, ...args],
  cwd: ".",
  ready: { output: new RegExp(`${name} READY`) },
  ...extra,
});

function run(plan, options = {}) {
  const output = capture();
  const signals = new EventEmitter();
  const exit = runDev({
    root,
    plan,
    output: output.stream,
    color: false,
    signals,
    startupTimeoutMs: 10_000,
    shutdownTimeoutMs: 3_000,
    ...options,
  });
  return { output, signals, exit };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((settle) => server.listen(0, "127.0.0.1", settle));
  const { port } = server.address();
  await new Promise((settle) => server.close(settle));
  return port;
}

describe("dev runner", () => {
  it("prefixes every line, reports ready, and exits 0 after forwarding SIGINT to every process", async () => {
    const { output, signals, exit } = run({
      build: { name: "build", tool: "node", args: ["exit.mjs", "once", "0"], cwd: "." },
      processes: [node("api", "service.mjs", ["api", "50"]), node("web", "service.mjs", ["web"])],
    });
    await output.waitFor(/dev +\| ready/);
    signals.emit("SIGINT");
    assert.equal(await exit, 0);
    assert.match(output.text, /^dev {3}\| build: node exit\.mjs once 0$/m);
    assert.match(output.text, /^build \| run once$/m);
    assert.match(output.text, /^api {3}\| api got SIGINT$/m);
    assert.match(output.text, /^web {3}\| web got SIGINT$/m);
    assert.match(output.text, /^dev {3}\| SIGINT received: stopping$/m);
    assert.equal(signals.listenerCount("SIGINT"), 0);
  });

  it("forwards SIGTERM the same way", async () => {
    const { output, signals, exit } = run({
      build: null,
      processes: [node("api", "service.mjs", ["api"])],
    });
    await output.waitFor(/ready/);
    signals.emit("SIGTERM");
    assert.equal(await exit, 0);
    assert.match(output.text, /api got SIGTERM/);
  });

  it("returns the build's exit code and starts nothing when the initial build fails", async () => {
    const { output, exit } = run({
      build: { name: "build", tool: "node", args: ["exit.mjs", "once", "3"], cwd: "." },
      processes: [node("api", "service.mjs", ["api"])],
    });
    assert.equal(await exit, 3);
    assert.match(output.text, /build failed, so nothing else was started/);
    assert.doesNotMatch(output.text, /api READY/);
  });

  it("exits non-zero and stops the others when a process exits while starting", async () => {
    const { output, exit } = run({
      build: null,
      processes: [node("web", "service.mjs", ["web"]), node("api", "exit.mjs", ["api-crash", "4"])],
    });
    assert.equal(await exit, 4);
    assert.match(output.text, /api stopped while starting \(exit code 4\)/);
    assert.match(output.text, /check apps\/api\/\.env/);
    assert.match(output.text, /web got SIGTERM/);
  });

  it("treats a failed-startup line as a startup failure even though the process keeps running", async () => {
    const { output, exit } = run({
      build: null,
      processes: [
        node(
          "api",
          "service.mjs",
          [
            "api",
            "0",
            "print:Failed running 'dist/main.js'. Waiting for file changes before restarting...",
          ],
          {
            failedStartup: /^Failed running /,
          },
        ),
      ],
    });
    assert.equal(await exit, 1);
    assert.match(output.text, /api failed to start: Failed running 'dist\/main\.js'/);
    assert.match(output.text, /api got SIGTERM/);
  });

  it("fails startup after the timeout when a process never becomes ready", async () => {
    const { output, exit } = run(
      {
        build: null,
        processes: [node("trigger", "service.mjs", ["trigger", "0", "print:still building"])],
      },
      { startupTimeoutMs: 300 },
    );
    assert.equal(await exit, 1);
    assert.match(output.text, /trigger was not ready within 0 s/);
  });

  it("waits for an HTTP readiness URL to answer 2xx", async () => {
    const port = await freePort();
    const { output, signals, exit } = run({
      build: null,
      processes: [
        {
          name: "api",
          tool: "node",
          args: ["http.mjs", String(port)],
          cwd: ".",
          ready: { url: `http://127.0.0.1:${port}/healthz` },
        },
      ],
    });
    await output.waitFor(/ready: api http:\/\/127\.0\.0\.1/);
    signals.emit("SIGINT");
    assert.equal(await exit, 0);
  });

  it("stops everything with the process's exit code when a ready process stops on its own", async () => {
    const { output, exit } = run({
      build: null,
      processes: [
        node("tsc", "service.mjs", ["tsc", "0", "exit-after:100:5"], {
          ready: { output: /tsc READY|exit-after/ },
        }),
        node("web", "service.mjs", ["web"]),
      ],
    });
    assert.equal(await exit, 5);
    assert.match(output.text, /tsc stopped \(exit code 5\), so every other process is stopping/);
    assert.match(output.text, /web got SIGTERM/);
  });

  it("kills a process that ignores the signal after the grace period and exits 1", async () => {
    const { output, signals, exit } = run(
      { build: null, processes: [node("stubborn", "stubborn.mjs", [])] },
      { shutdownTimeoutMs: 300 },
    );
    await output.waitFor(/ready/);
    signals.emit("SIGTERM");
    assert.equal(await exit, 1);
    assert.match(output.text, /stubborn ignores SIGTERM/);
  });

  it("kills a process after its own shorter grace period when that kill is expected", async () => {
    const { output, signals, exit } = run(
      {
        build: null,
        processes: [
          node("stubborn", "stubborn.mjs", [], { shutdown: { timeoutMs: 200, killIsClean: true } }),
          node("api", "service.mjs", ["api"]),
        ],
      },
      { shutdownTimeoutMs: 60_000 },
    );
    await output.waitFor(/ready/);
    const started = Date.now();
    signals.emit("SIGINT");
    assert.equal(await exit, 0);
    assert.ok(Date.now() - started < 10_000);
    assert.match(output.text, /api got SIGINT/);
  });

  it("kills immediately on a second signal", async () => {
    const { output, signals, exit } = run(
      { build: null, processes: [node("stubborn", "stubborn.mjs", [])] },
      { shutdownTimeoutMs: 60_000 },
    );
    await output.waitFor(/ready/);
    const started = Date.now();
    signals.emit("SIGINT");
    await output.waitFor(/stubborn ignores SIGINT/);
    signals.emit("SIGINT");
    assert.equal(await exit, 1);
    assert.ok(Date.now() - started < 10_000);
    assert.match(output.text, /SIGINT again: killing every process/);
  });

  it("stops processes the commands started themselves", async () => {
    const pidFile = join(root, "grandchild.pid");
    const { output, signals, exit } = run({
      build: null,
      processes: [node("parent", "parent.mjs", [pidFile])],
    });
    await output.waitFor(/ready/);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    assert.ok(alive(grandchild));
    signals.emit("SIGTERM");
    // The grandchild ignores SIGTERM, so only the process group SIGKILL after the grace period ends it.
    assert.equal(await exit, 1);
    const deadline = Date.now() + 2_000;
    while (alive(grandchild) && Date.now() < deadline) {
      await new Promise((settle) => setTimeout(settle, 20));
    }
    assert.equal(alive(grandchild), false);
  });

  it("fails before starting anything when a package binary is missing", async () => {
    const output = capture();
    await assert.rejects(
      runDev({
        root,
        plan: {
          build: null,
          processes: [
            {
              name: "web",
              tool: { package: "next", bin: "next", from: "." },
              args: ["dev"],
              cwd: ".",
              ready: { output: /x/ },
            },
          ],
        },
        output: output.stream,
        color: false,
        signals: new EventEmitter(),
      }),
      /next is not installed/,
    );
    assert.equal(output.text, "");
  });
});
