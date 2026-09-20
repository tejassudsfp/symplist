import { describe, expect, it } from "vitest";
import {
  applyMerge,
  defaultChoices,
  MAX_MERGE_SECTIONS,
  type MergeStatus,
  mergeStatusLabel,
  planMerge,
} from "./merge.ts";

const base = [
  "## Overview",
  "",
  "The original overview.",
  "",
  "## Next steps",
  "",
  "* One",
  "",
].join("\n");

function entry(plan: ReturnType<typeof planMerge>, heading: string | null) {
  const found = plan.entries.find((candidate) => candidate.heading === heading);
  if (!found) throw new Error(`no entry for ${heading}`);
  return found;
}

describe("planMerge", () => {
  it("reports a section only the saved page changed and asks for no choice", () => {
    const saved = base.replace("The original overview.", "Simon rewrote the overview.");
    const plan = planMerge(base, saved, base);
    expect(entry(plan, "Overview").status).toBe("saved_changed");
    expect(plan.conflicts).toHaveLength(0);
    expect(applyMerge(plan, defaultChoices(plan))).toBe(saved);
  });

  it("reports a section only the draft changed and keeps the draft", () => {
    const draft = base.replace("* One", "* One\n* Two");
    const plan = planMerge(base, base, draft);
    expect(entry(plan, "Next steps").status).toBe("draft_changed");
    expect(plan.conflicts).toHaveLength(0);
    expect(applyMerge(plan, defaultChoices(plan))).toBe(draft);
  });

  it("keeps both sides when the two changed different sections", () => {
    const saved = base.replace("The original overview.", "Simon rewrote the overview.");
    const draft = base.replace("* One", "* One\n* Two");
    const plan = planMerge(base, saved, draft);
    expect(plan.conflicts).toHaveLength(0);
    const merged = applyMerge(plan, defaultChoices(plan));
    expect(merged).toContain("Simon rewrote the overview.");
    expect(merged).toContain("* Two");
  });

  it("asks for a choice only where both sides changed the same section", () => {
    const saved = base.replace("* One", "* One (Simon)");
    const draft = base.replace("* One", "* One (mine)");
    const plan = planMerge(base, saved, draft);
    expect(plan.conflicts.map((conflict) => conflict.heading)).toEqual(["Next steps"]);
    const conflict = plan.conflicts[0];
    if (!conflict) throw new Error("expected a conflict");
    expect(conflict.defaultChoice).toBe("draft");
    expect(applyMerge(plan, defaultChoices(plan))).toContain("* One (mine)");
    expect(applyMerge(plan, { [conflict.key]: "saved" })).toContain("* One (Simon)");
  });

  it("treats a section only the draft adds as an addition, with no choice", () => {
    const draft = `${base}\n## Links\n\n* <https://example.com>\n`;
    const plan = planMerge(base, base, draft);
    expect(entry(plan, "Links").status).toBe("added_draft");
    expect(plan.conflicts).toHaveLength(0);
    expect(applyMerge(plan, defaultChoices(plan))).toContain("## Links");
  });

  it("treats a section only the saved page adds as an addition, with no choice", () => {
    const saved = `${base}\n## Links\n\n* <https://example.com>\n`;
    const plan = planMerge(base, saved, base);
    expect(entry(plan, "Links").status).toBe("added_saved");
    expect(plan.conflicts).toHaveLength(0);
    expect(applyMerge(plan, defaultChoices(plan))).toContain("## Links");
  });

  it("drops a section the draft deleted and the saved page left alone", () => {
    const draft = base.slice(0, base.indexOf("## Next steps"));
    const plan = planMerge(base, base, draft);
    expect(entry(plan, "Next steps").status).toBe("removed_draft");
    expect(plan.conflicts).toHaveLength(0);
    expect(applyMerge(plan, defaultChoices(plan))).not.toContain("## Next steps");
  });

  it("asks before dropping a section the draft deleted and the saved page changed", () => {
    const saved = base.replace("* One", "* One (Simon)");
    const draft = base.slice(0, base.indexOf("## Next steps"));
    const plan = planMerge(base, saved, draft);
    const conflict = entry(plan, "Next steps");
    expect(conflict.status).toBe("both_changed");
    expect(conflict.needsChoice).toBe(true);
    expect(conflict.defaultChoice).toBe("saved");
    expect(conflict.draftText).toBeNull();
  });

  it("asks before dropping an edit the saved page deleted", () => {
    const saved = base.slice(0, base.indexOf("## Next steps"));
    const draft = base.replace("* One", "* One (mine)");
    const plan = planMerge(base, saved, draft);
    const conflict = entry(plan, "Next steps");
    expect(conflict.needsChoice).toBe(true);
    expect(conflict.defaultChoice).toBe("draft");
    expect(applyMerge(plan, defaultChoices(plan))).toContain("* One (mine)");
  });

  it("falls back to a whole-document choice past the section limit", () => {
    const huge = Array.from(
      { length: MAX_MERGE_SECTIONS + 5 },
      (_, i) => `## H${i}\n\nbody\n`,
    ).join("\n");
    const plan = planMerge("", huge, `${huge}\nextra\n`);
    expect(plan.wholeDocument).toBe(true);
    expect(plan.entries).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(1);
    expect(applyMerge(plan, { document: "saved" })).toBe(huge);
  });

  it("reports no conflict when the two documents are identical", () => {
    const plan = planMerge(base, base, base);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.entries.every((item) => item.status === "unchanged")).toBe(true);
    expect(applyMerge(plan, defaultChoices(plan))).toBe(base);
  });

  it("treats every section as changed when the base is unavailable", () => {
    const saved = base.replace("* One", "* One (Simon)");
    const draft = base.replace("* One", "* One (mine)");
    const plan = planMerge("", saved, draft);
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.wholeDocument).toBe(false);
  });

  it("produces a whole document from the chosen sides, byte for byte", () => {
    const saved = base.replace("The original overview.", "Simon rewrote the overview.");
    const draft = base.replace("* One", "* One (mine)");
    const plan = planMerge(base, saved, draft);
    const allSaved = Object.fromEntries(plan.entries.map((item) => [item.key, "saved" as const]));
    const allDraft = Object.fromEntries(plan.entries.map((item) => [item.key, "draft" as const]));
    expect(applyMerge(plan, allSaved)).toBe(saved);
    expect(applyMerge(plan, allDraft)).toBe(draft);
  });

  it("keeps section keys stable across re-planning the same three documents", () => {
    const saved = base.replace("* One", "* One (Simon)");
    const draft = base.replace("* One", "* One (mine)");
    expect(planMerge(base, saved, draft).entries.map((item) => item.key)).toEqual(
      planMerge(base, saved, draft).entries.map((item) => item.key),
    );
  });

  it("distinguishes repeated identical headings by their order", () => {
    const repeated = "## A\n\none\n\n## A\n\ntwo\n";
    const keys = planMerge(repeated, repeated, repeated).entries.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("mergeStatusLabel", () => {
  it("names every status without relying on colour", () => {
    const statuses: MergeStatus[] = [
      "unchanged",
      "saved_changed",
      "draft_changed",
      "both_changed",
      "added_draft",
      "added_saved",
      "removed_draft",
      "removed_saved",
    ];
    const labels = statuses.map(mergeStatusLabel);
    expect(new Set(labels).size).toBe(statuses.length);
    for (const label of labels) expect(label).not.toMatch(/red|green/i);
  });
});
