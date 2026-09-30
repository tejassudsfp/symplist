import { describe, expect, it } from "vitest";
import { externalLinkDecision, isInternalUrl, isTrustedFrame } from "./navigation.ts";

const rendererOrigin = "http://127.0.0.1:53421";

describe("isInternalUrl", () => {
  it("accepts pages of the renderer's own origin", () => {
    expect(isInternalUrl(`${rendererOrigin}/now`, rendererOrigin)).toBe(true);
    expect(isInternalUrl(`${rendererOrigin}/tasks/abc?x=1#y`, rendererOrigin)).toBe(true);
  });

  it("refuses another port, another loopback spelling and another scheme", () => {
    expect(isInternalUrl("http://127.0.0.1:53422/now", rendererOrigin)).toBe(false);
    expect(isInternalUrl("http://localhost:53421/now", rendererOrigin)).toBe(false);
    expect(isInternalUrl("https://127.0.0.1:53421/now", rendererOrigin)).toBe(false);
  });

  it("refuses the cloud app and anything unparseable", () => {
    expect(isInternalUrl("https://app.symplist.tejassuds.com/now", rendererOrigin)).toBe(false);
    expect(isInternalUrl("not a url", rendererOrigin)).toBe(false);
    expect(isInternalUrl(rendererOrigin, "not an origin")).toBe(false);
  });
});

describe("externalLinkDecision", () => {
  it("hands http, https and mailto links to the operating system", () => {
    expect(externalLinkDecision("https://example.com/doc")).toBe("open-externally");
    expect(externalLinkDecision("http://example.com/doc")).toBe("open-externally");
    expect(externalLinkDecision("mailto:someone@example.com")).toBe("open-externally");
  });

  it("refuses schemes that read the disk or run code chosen by a document's author", () => {
    expect(externalLinkDecision("file:///etc/passwd")).toBe("deny");
    expect(externalLinkDecision("javascript:alert(1)")).toBe("deny");
    expect(externalLinkDecision("data:text/html,<script>1</script>")).toBe("deny");
    expect(externalLinkDecision("vscode://open")).toBe("deny");
    expect(externalLinkDecision("")).toBe("deny");
  });
});

describe("isTrustedFrame", () => {
  it("accepts only the top frame of the renderer origin", () => {
    expect(isTrustedFrame({ url: `${rendererOrigin}/now`, isTopFrame: true }, rendererOrigin)).toBe(
      true,
    );
  });

  it("refuses a subframe, a foreign page and a missing frame", () => {
    expect(
      isTrustedFrame({ url: `${rendererOrigin}/now`, isTopFrame: false }, rendererOrigin),
    ).toBe(false);
    expect(
      isTrustedFrame({ url: "https://evil.example/x", isTopFrame: true }, rendererOrigin),
    ).toBe(false);
    expect(isTrustedFrame(null, rendererOrigin)).toBe(false);
  });
});
