import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeDocument,
  clearActiveDocument,
  type DocumentController,
  setActiveDocument,
} from "./controller.ts";
import { outlineRequestHandler, setOutlineRequestHandler } from "./outline-request.ts";

function controller(taskId: string, editable = true): DocumentController {
  return { taskId, editable, save: vi.fn(), find: vi.fn(() => true) };
}

afterEach(() => {
  setActiveDocument(null);
  setOutlineRequestHandler(null);
});

describe("the mounted task page's controller", () => {
  it("is null until a page registers itself", () => {
    expect(activeDocument()).toBeNull();
  });

  it("reports the mounted page and its editability", () => {
    const page = controller("task-1", false);
    setActiveDocument(page);
    expect(activeDocument()).toBe(page);
    expect(activeDocument()?.editable).toBe(false);
  });

  it("replaces the registration when another page mounts", () => {
    const first = controller("task-1");
    const second = controller("task-2");
    setActiveDocument(first);
    setActiveDocument(second);
    expect(activeDocument()).toBe(second);
  });

  it("clears only its own registration, so unmount ordering cannot blank a live page", () => {
    const first = controller("task-1");
    const second = controller("task-2");
    setActiveDocument(first);
    setActiveDocument(second);
    // The outgoing page's cleanup runs after the incoming page registered.
    clearActiveDocument(first);
    expect(activeDocument()).toBe(second);
    clearActiveDocument(second);
    expect(activeDocument()).toBeNull();
  });

  it("clears the registration with null", () => {
    setActiveDocument(controller("task-1"));
    setActiveDocument(null);
    expect(activeDocument()).toBeNull();
  });
});

describe("the outline request seam", () => {
  it("is absent until Simon registers a handler", () => {
    expect(outlineRequestHandler()).toBeNull();
  });

  it("hands the task id to the registered handler", async () => {
    const handler = vi.fn();
    setOutlineRequestHandler(handler);
    await outlineRequestHandler()?.("task-1");
    expect(handler).toHaveBeenCalledWith("task-1");
  });

  it("is removed again with null", () => {
    setOutlineRequestHandler(vi.fn());
    setOutlineRequestHandler(null);
    expect(outlineRequestHandler()).toBeNull();
  });
});
