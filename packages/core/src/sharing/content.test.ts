import { describe, expect, it } from "vitest";
import { exportMarkdown, handoffTemplate } from "./content.ts";

describe("artifact export boundaries", () => {
  it("strips absolute private-origin links and bare autolinks as well as relative app paths", () => {
    const result = exportMarkdown(
      "[App](https://app.example/tasks/private)\nhttps://api.example/v1/tasks/private\n",
      ["https://app.example", "https://api.example"],
    );
    expect(result).not.toContain("](https://app.example");
    expect(result).not.toContain("<https://api.example");
  });
  it("removes credentials and capability URLs before encrypted storage", () => {
    const content = exportMarkdown(
      `A sym_${"a".repeat(32)} and sk-${"b".repeat(32)}\nBearer ${"c".repeat(32)}\n[secret](https://share.example/artifact/id?key=CAPABILITY)\n`,
    );
    for (const marker of ["a".repeat(32), "b".repeat(32), "c".repeat(32), "CAPABILITY"])
      expect(content).not.toContain(marker);
    expect(content).toContain("credential removed");
  });
  it("makes app paths and internal object references inert in inline and reference links", () => {
    const result = exportMarkdown(
      "[Task](/tasks/private)\n![Object](https://storage.example/u/owner/docs/raw)\n[Ref][internal]\n\n[internal]: /vault/private\n",
    );
    expect(result).not.toContain("/tasks/private");
    expect(result).not.toContain("/u/owner/docs/raw");
    expect(result).not.toContain("/vault/private");
    expect(result).toContain("Task");
    expect(result).toContain("Ref");
  });
  it("keeps public https source context and does not promise to detect arbitrary secret text", () => {
    const result = exportMarkdown(
      "[Docs](https://example.com/reference)\nordinary-context-marker\n",
    );
    expect(result).toContain("https://example.com/reference");
    expect(result).toContain("ordinary-context-marker");
  });
  it("saved handoffs contain only placeholders with explicit return and expiry instructions", () => {
    const result = handoffTemplate("Read https://share.example/artifact/id?key=PRIVATE", [
      "artifact-id",
    ]);
    expect(result).toContain("{{artifact:artifact-id}}");
    expect(result).not.toContain("key=PRIVATE");
    expect(result).toContain("does not authorize editing");
    expect(result).toContain("expires");
  });
});
