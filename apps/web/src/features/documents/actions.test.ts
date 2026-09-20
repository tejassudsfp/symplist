import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionEnvironment, ActionServices, WorkspaceRoute } from "@/actions/types";
import { documentsActions } from "./actions.ts";
import { type DocumentController, setActiveDocument } from "./controller.ts";
import { setOutlineRequestHandler } from "./outline-request.ts";

function environment(route: WorkspaceRoute | null, shell: ActionServices["shell"] = null) {
  const services: ActionServices = {
    navigate: vi.fn(),
    assign: vi.fn(),
    announce: vi.fn(),
    route,
    shell,
  };
  const env: ActionEnvironment = { source: "keyboard", platform: "other", pane: "page", services };
  return { env, services };
}

function page(overrides: Partial<DocumentController> = {}): DocumentController {
  return {
    taskId: "task-1",
    editable: true,
    save: vi.fn(),
    find: vi.fn(() => true),
    ...overrides,
  };
}

const byId = (id: string) => {
  const action = documentsActions.find((candidate) => candidate.id === id);
  if (!action) throw new Error(`no action ${id}`);
  return action;
};

const taskId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a";

afterEach(() => {
  setActiveDocument(null);
  setOutlineRequestHandler(null);
});

describe("the documents actions", () => {
  it("declares the note 13 bindings and contexts", () => {
    expect(byId("documents.open_history")).toMatchObject({
      defaultBinding: "g h",
      context: "app",
      group: "page",
    });
    expect(byId("documents.save")).toMatchObject({ defaultBinding: "mod+s", context: "editor" });
    expect(byId("documents.find_in_document")).toMatchObject({
      defaultBinding: "mod+f",
      context: "editor",
    });
  });

  it("keeps browser save and find available outside the editor", () => {
    // Both editor actions are declared in the `editor` context, so dispatch only reaches them
    // while the document editor holds focus (§10.2).
    for (const id of ["documents.save", "documents.find_in_document"]) {
      expect(byId(id).context).toBe("editor");
    }
  });

  it("gives every action a unique id and a label", () => {
    const ids = documentsActions.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const action of documentsActions) expect(action.label.length).toBeGreaterThan(0);
  });
});

describe("documents.open_history", () => {
  it("needs an open task and says so", () => {
    const { env } = environment(null);
    expect(byId("documents.open_history").availability(env)).toEqual({
      enabled: false,
      reason: "Open a task first",
    });
  });

  it("opens history carrying the task page it was entered from", async () => {
    const { env, services } = environment({ collection: "later", taskId });
    expect(byId("documents.open_history").availability(env)).toEqual({ enabled: true });
    await byId("documents.open_history").run(env);
    expect(services.navigate).toHaveBeenCalledWith(
      `/tasks/${taskId}/history?from=${encodeURIComponent(`/later/${taskId}`)}`,
    );
  });

  it("does nothing when it is run without a task", async () => {
    const { env, services } = environment(null);
    await byId("documents.open_history").run(env);
    expect(services.navigate).not.toHaveBeenCalled();
  });
});

describe("documents.open_artifacts", () => {
  it("needs an open task and says so", () => {
    const { env } = environment(null);
    expect(byId("documents.open_artifacts").availability(env)).toEqual({
      enabled: false,
      reason: "Open a task first",
    });
  });

  it("opens the task's artifacts carrying the page it was entered from", async () => {
    const { env, services } = environment({ collection: "now", taskId });
    expect(byId("documents.open_artifacts").availability(env)).toEqual({ enabled: true });
    await byId("documents.open_artifacts").run(env);
    expect(services.navigate).toHaveBeenCalledWith(
      `/tasks/${taskId}/artifacts?from=${encodeURIComponent(`/now/${taskId}`)}`,
    );
  });

  it("does nothing when it is run without a task", async () => {
    const { env, services } = environment(null);
    await byId("documents.open_artifacts").run(env);
    expect(services.navigate).not.toHaveBeenCalled();
  });
});

describe("documents.save", () => {
  it("needs a mounted page and says so", () => {
    const { env } = environment({ collection: "now", taskId });
    expect(byId("documents.save").availability(env)).toEqual({
      enabled: false,
      reason: "Open a task page first",
    });
  });

  it("is unavailable with a reason on a read-only page", () => {
    setActiveDocument(page({ editable: false }));
    const { env } = environment({ collection: "now", taskId });
    expect(byId("documents.save").availability(env)).toEqual({
      enabled: false,
      reason: "This page is read-only",
    });
  });

  it("publishes through the same handle the page's own controls use", async () => {
    const controller = page();
    setActiveDocument(controller);
    const { env } = environment({ collection: "now", taskId });
    expect(byId("documents.save").availability(env)).toEqual({ enabled: true });
    await byId("documents.save").run(env);
    expect(controller.save).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the page unmounted between the check and the run", () => {
    const { env } = environment({ collection: "now", taskId });
    expect(() => byId("documents.save").run(env)).not.toThrow();
  });
});

describe("documents.find_in_document", () => {
  it("needs a mounted page", () => {
    const { env } = environment({ collection: "now", taskId });
    expect(byId("documents.find_in_document").availability(env)).toEqual({
      enabled: false,
      reason: "Open a task page first",
    });
  });

  it("opens the in-document find bar, read-only pages included", async () => {
    const controller = page({ editable: false });
    setActiveDocument(controller);
    const { env } = environment({ collection: "now", taskId });
    expect(byId("documents.find_in_document").availability(env)).toEqual({ enabled: true });
    await byId("documents.find_in_document").run(env);
    expect(controller.find).toHaveBeenCalledTimes(1);
  });
});

describe("documents.ask_outline", () => {
  it("needs an open task", () => {
    const { env } = environment(null);
    expect(byId("documents.ask_outline").availability(env)).toEqual({
      enabled: false,
      reason: "Open a task first",
    });
  });

  it("is present but unavailable with a reason until Simon registers a handler", () => {
    const { env } = environment({ collection: "now", taskId });
    expect(byId("documents.ask_outline").availability(env)).toEqual({
      enabled: false,
      reason: "Simon isn't available yet",
    });
  });

  it("runs Simon's handler for the open task once it is registered", async () => {
    const handler = vi.fn();
    setOutlineRequestHandler(handler);
    const { env } = environment({ collection: "now", taskId });
    expect(byId("documents.ask_outline").availability(env)).toEqual({ enabled: true });
    await byId("documents.ask_outline").run(env);
    expect(handler).toHaveBeenCalledWith(taskId);
  });

  it("reveals and focuses chat after Simon prepares the outline request", async () => {
    const handler = vi.fn();
    const focusPane = vi.fn();
    setOutlineRequestHandler(handler);
    const shell = {
      focusPane,
      revealInbox: vi.fn(),
      toggleInbox: vi.fn(),
      toggleChat: vi.fn(),
      isInboxVisible: vi.fn(() => true),
      isChatVisible: vi.fn(() => false),
    };
    const { env } = environment({ collection: "now", taskId }, shell);
    await byId("documents.ask_outline").run(env);
    expect(focusPane).toHaveBeenCalledWith("chat");
  });

  it("does nothing when the handler disappeared between the check and the run", async () => {
    const { env } = environment({ collection: "now", taskId });
    await expect(byId("documents.ask_outline").run(env)).resolves.toBeUndefined();
  });
});
