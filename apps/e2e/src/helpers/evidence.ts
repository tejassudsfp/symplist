import type { Locator, Page, TestInfo } from "@playwright/test";

/**
 * Screenshot evidence for e2e flows (§17): every captured frame is named after the design handoff
 * convention `screen / state / theme / mode / viewport` (overall.md), saved under the test's output
 * directory and attached to the report, so CI keeps it with the run.
 */
export interface EvidenceName {
  /** The screen brief, for example `workspace_now`. */
  readonly screen: string;
  /** The state shown, for example `populated` or `approval-pending`. */
  readonly state: string;
  /** Theme id; defaults to `studio`. */
  readonly theme?: string;
  /** Brightness mode; defaults to `light`. */
  readonly mode?: "light" | "dark";
}

export interface EvidenceOptions {
  readonly fullPage?: boolean;
  /** Regions that change between runs (clocks, relative times) to cover in the image. */
  readonly mask?: readonly Locator[];
}

const segmentPattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function segment(value: string, label: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!segmentPattern.test(normalized)) {
    throw new Error(`Evidence ${label} "${value}" must use letters, digits, '-' or '_'`);
  }
  return normalized;
}

/** `workspace_now--populated--studio--light--desktop-1440.png` */
export function evidenceFileName(name: EvidenceName, viewport: string): string {
  return `${[
    segment(name.screen, "screen"),
    segment(name.state, "state"),
    segment(name.theme ?? "studio", "theme"),
    segment(name.mode ?? "light", "mode"),
    segment(viewport, "viewport"),
  ].join("--")}.png`;
}

/** The viewport label for a test: the Playwright project name plus the page width. */
export function viewportLabel(page: Page, testInfo: TestInfo): string {
  const width = page.viewportSize()?.width;
  const project = testInfo.project.name || "default";
  return width === undefined ? project : `${project}-${width}`;
}

/** Captures one evidence screenshot with animations disabled and attaches it to the report. */
export async function captureEvidence(
  page: Page,
  testInfo: TestInfo,
  name: EvidenceName,
  options: EvidenceOptions = {},
): Promise<string> {
  const fileName = evidenceFileName(name, viewportLabel(page, testInfo));
  const path = testInfo.outputPath("evidence", fileName);
  await page.screenshot({
    path,
    fullPage: options.fullPage ?? true,
    animations: "disabled",
    caret: "hide",
    ...(options.mask === undefined ? {} : { mask: [...options.mask] }),
  });
  await testInfo.attach(fileName, { path, contentType: "image/png" });
  return path;
}
