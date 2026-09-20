import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

/** The WCAG 2.2 AA rule set every e2e page is checked against (§17, overall.md accessibility). */
export const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

export type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
export type AxeViolation = AxeResults["violations"][number];

/** A rule switched off for one check, with the reason recorded next to it. */
export interface DisabledAxeRule {
  readonly id: string;
  readonly reason: string;
}

export interface AxeCheckOptions {
  /** CSS selectors to limit the check to, for example an open dialog. */
  readonly include?: readonly string[];
  /** CSS selectors to leave out, for example a third-party frame. */
  readonly exclude?: readonly string[];
  readonly disableRules?: readonly DisabledAxeRule[];
}

/** Runs axe on the page with the WCAG 2.2 AA tags. */
export async function analyzeAccessibility(
  page: Page,
  options: AxeCheckOptions = {},
): Promise<AxeResults> {
  // Audit the page a person ends up on, not one still assembling itself. A screen reached by a
  // document navigation can have its heading on screen — which is what a spec waits for — while the
  // rest of the stream is still arriving, and React re-attaches the document's metadata as it
  // hydrates, so an audit run at that instant can fall between the server's <title> and the
  // client's. Both waits are bounded and neither hides a real defect: a page that genuinely has no
  // title still reaches axe, which reports it.
  await page.waitForLoadState("load");
  await page
    .waitForFunction(() => document.title.length > 0, undefined, { timeout: 2_000 })
    .catch(() => undefined);
  const builder = new AxeBuilder({ page }).withTags([...wcagTags]);
  for (const selector of options.include ?? []) builder.include(selector);
  for (const selector of options.exclude ?? []) builder.exclude(selector);
  const disabled = options.disableRules ?? [];
  for (const rule of disabled) {
    if (rule.reason.trim() === "") throw new Error(`Disabling axe rule ${rule.id} needs a reason`);
  }
  if (disabled.length > 0) builder.disableRules(disabled.map((rule) => rule.id));
  return builder.analyze();
}

/** A readable summary: one block per violation with its impact, help link and failing targets. */
export function formatAxeViolations(violations: readonly AxeViolation[]): string {
  if (violations.length === 0) return "No accessibility violations.";
  return violations
    .map((violation) => {
      const targets = violation.nodes
        .slice(0, 5)
        .map((node) => `    - ${node.target.map(String).join(" ")}`)
        .join("\n");
      const more =
        violation.nodes.length > 5 ? `\n    - …and ${violation.nodes.length - 5} more` : "";
      return `[${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n  ${violation.helpUrl}\n${targets}${more}`;
    })
    .join("\n\n");
}

/**
 * Checks the page against WCAG 2.2 AA, attaches the full axe results to the test report, and fails
 * with a readable summary when anything is violated.
 */
export async function expectNoAxeViolations(
  page: Page,
  testInfo: TestInfo,
  options: AxeCheckOptions & { readonly label?: string } = {},
): Promise<AxeResults> {
  const results = await analyzeAccessibility(page, options);
  const label = options.label ?? "axe";
  await testInfo.attach(`${label}-results.json`, {
    body: JSON.stringify(
      {
        url: results.url,
        disabledRules: options.disableRules ?? [],
        violations: results.violations,
        incomplete: results.incomplete.map((entry) => ({
          id: entry.id,
          nodes: entry.nodes.length,
        })),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(results.violations, formatAxeViolations(results.violations)).toEqual([]);
  return results;
}
