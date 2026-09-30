import { describe, expect, it } from "vitest";
import { createMainLog, redactSecrets } from "./log.ts";

describe("redactSecrets", () => {
  it("removes authorization headers, keeping the scheme so the line still reads", () => {
    expect(redactSecrets("GET /mcp authorization: Bearer mcp_live_8f3ab21c9d")).not.toContain(
      "mcp_live_8f3ab21c9d",
    );
    expect(redactSecrets("Bearer mcp_live_8f3ab21c9d")).toBe("Bearer [redacted]");
  });

  it("removes provider key shapes and our own envelopes", () => {
    expect(redactSecrets("openai rejected sk-ant-api03-Zk9f2Lq")).toBe(
      "openai rejected [redacted]",
    );
    expect(redactSecrets("stored sym1.ZGF0YWtleS52MQ.abc123def")).toBe("stored [redacted]");
  });

  it("keeps the name of a credential-shaped assignment and drops its value", () => {
    expect(redactSecrets('{"apiKey":"sk_test_51H"}')).toBe('{"apiKey":"[redacted]"}');
    expect(redactSecrets("ANTHROPIC_API_KEY=abcd1234 next")).toBe(
      "ANTHROPIC_API_KEY=[redacted] next",
    );
    expect(redactSecrets("session_token: aaa.bbb.ccc")).toBe("session_token: [redacted]");
  });

  it("leaves ordinary output alone", () => {
    const line = "Ready in 812ms on http://127.0.0.1:53421";
    expect(redactSecrets(line)).toBe(line);
  });
});

describe("createMainLog", () => {
  it("writes one JSON line per event with the fields it was given", () => {
    const lines: string[] = [];
    const log = createMainLog((line) => lines.push(line));
    log.info("renderer.ready", { durationMs: 812 });
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      level: "info",
      event: "renderer.ready",
      durationMs: 812,
    });
  });

  it("redacts a child process line and drops blank ones", () => {
    const lines: string[] = [];
    const log = createMainLog((line) => lines.push(line));
    log.child("harness", "  \n");
    log.child("harness", "retrying with Bearer mcp_live_8f3ab21c9d\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "") as { line: string; source: string };
    expect(entry.source).toBe("harness");
    expect(entry.line).toBe("retrying with Bearer [redacted]");
  });
});
