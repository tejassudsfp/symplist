import { describe, expect, it } from "vitest";
import { backToPageHref, documentHistoryPath, safeReturnPath } from "./routes.ts";

const taskId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a";

describe("safeReturnPath", () => {
  it("accepts an in-app task page in each collection", () => {
    for (const collection of ["now", "later", "unclassified"]) {
      expect(safeReturnPath(`/${collection}/${taskId}`)).toBe(`/${collection}/${taskId}`);
    }
  });

  it("drops a query string and fragment rather than carrying them back", () => {
    expect(safeReturnPath(`/now/${taskId}?focus=chat#top`)).toBe(`/now/${taskId}`);
  });

  it("refuses anything that could navigate off site", () => {
    for (const hostile of [
      "https://evil.example/now/x",
      "//evil.example/now/x",
      "/\\evil.example/now/x",
      "javascript:alert(1)",
      `/now/${taskId}\\..`,
      "now/x",
    ]) {
      expect(safeReturnPath(hostile)).toBeNull();
    }
  });

  it("refuses a path that is not exactly a task page in a known collection", () => {
    expect(safeReturnPath("/now")).toBeNull();
    expect(safeReturnPath(`/archive/${taskId}`)).toBeNull();
    expect(safeReturnPath(`/settings/${taskId}`)).toBeNull();
    expect(safeReturnPath(`/now/${taskId}/history`)).toBeNull();
    expect(safeReturnPath("/now/has spaces")).toBeNull();
    expect(safeReturnPath(`/now/${"x".repeat(129)}`)).toBeNull();
  });

  it("refuses a non-string", () => {
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
  });
});

describe("documentHistoryPath", () => {
  it("carries a valid entry page so Back returns exactly there", () => {
    expect(documentHistoryPath(taskId, `/later/${taskId}`)).toBe(
      `/tasks/${taskId}/history?from=${encodeURIComponent(`/later/${taskId}`)}`,
    );
  });

  it("omits an unusable entry page instead of encoding it", () => {
    expect(documentHistoryPath(taskId, "https://evil.example")).toBe(`/tasks/${taskId}/history`);
    expect(documentHistoryPath(taskId)).toBe(`/tasks/${taskId}/history`);
  });

  it("escapes the task id", () => {
    expect(documentHistoryPath("a/b")).toBe("/tasks/a%2Fb/history");
  });
});

describe("backToPageHref", () => {
  it("returns the entry page when it is safe", () => {
    expect(backToPageHref(taskId, `/unclassified/${taskId}`)).toBe(`/unclassified/${taskId}`);
  });

  it("falls back to Now for a missing or hostile entry page", () => {
    expect(backToPageHref(taskId, null)).toBe(`/now/${taskId}`);
    expect(backToPageHref(taskId, "//evil.example")).toBe(`/now/${taskId}`);
  });
});
