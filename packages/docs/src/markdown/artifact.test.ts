import { describe, expect, it } from "vitest";
import { renderArtifactMarkdown } from "./artifact.ts";

describe("standalone artifact sanitizer", () => {
  it("renders raw HTML as inert text and drops all active media", () => {
    const html = renderArtifactMarkdown(
      '<script>alert(1)</script>\n\n<iframe src="https://evil.example"></iframe>\n\n![A picture](https://images.example/pixel)\n',
    );
    expect(html).not.toMatch(/<(?:script|iframe|img|video|audio|picture|source)\b/);
    expect(html).toContain("&#x3C;script>");
    expect(html).toContain("A picture (images.example)");
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
  it("permits only https/mailto links and makes private app navigation inert", () => {
    const html = renderArtifactMarkdown(
      "[App](/tasks/private) [Unsafe](javascript:alert) [HTTP](http://example.com) [Docs](https://example.com) [Email](mailto:hello@example.com)\n",
    );
    expect(html).not.toContain('href="/tasks');
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('href="http:');
    expect(html).toContain('href="https://example.com');
    expect(html).toContain('href="mailto:');
  });
  it("cannot reactivate private reference definitions or reference images", () => {
    const html = renderArtifactMarkdown(
      "[Private][x]\n![Tracking][y]\n\n[x]: /vault/private\n[y]: https://tracking.example/image\n",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="/vault');
    expect(html).toContain("Private");
  });
});
