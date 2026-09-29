import { describe, expect, it, vi } from "vitest";
import { shellActions } from "./shell-actions.ts";
import type {
  ActionEnvironment,
  ActionServices,
  ShellController,
  WorkspaceRoute,
} from "./types.ts";

function environment(route: WorkspaceRoute | null, withShell = true) {
  const shell: ShellController = {
    focusPane: vi.fn(),
    revealInbox: vi.fn(),
    toggleInbox: vi.fn(),
    isInboxVisible: () => true,
  };
  const services: ActionServices = {
    navigate: vi.fn(),
    assign: vi.fn(),
    announce: vi.fn(),
    route,
    shell: withShell ? shell : null,
  };
  const env: ActionEnvironment = { source: "keyboard", platform: "other", pane: null, services };
  return { env, services, shell };
}

const byId = (id: string) => {
  const action = shellActions.find((candidate) => candidate.id === id);
  if (!action) throw new Error(id);
  return action;
};

describe("shell actions", () => {
  it.each([
    ["shell.go_now", "/now"],
    ["shell.go_later", "/later"],
    ["shell.go_unclassified", "/unclassified"],
  ])("%s opens the %s collection and focuses its task list", async (id, href) => {
    const { env, services, shell } = environment({ collection: "now", taskId: "t1" });
    expect(byId(id).availability(env)).toEqual({ enabled: true });
    await byId(id).run(env);
    expect(services.navigate).toHaveBeenCalledWith(href);
    expect(shell.revealInbox).toHaveBeenCalledTimes(1);
    expect(services.assign).not.toHaveBeenCalled();

    // Outside the workspace (settings, archive) there is no list to focus before navigation.
    const outside = environment(null, false);
    await byId(id).run(outside.env);
    expect(outside.services.navigate).toHaveBeenCalledWith(href);
  });

  it.each([
    ["shell.go_archive", "/archive"],
    ["shell.go_settings", "/settings/account"],
  ])("%s navigates client-side to %s", async (id, href) => {
    const { env, services } = environment(null, false);
    expect(byId(id).availability(env)).toEqual({ enabled: true });
    await byId(id).run(env);
    expect(services.navigate).toHaveBeenCalledWith(href);
    expect(services.assign).not.toHaveBeenCalled();
  });

  it("does not move focus to the list for archive and settings", async () => {
    const { env, shell } = environment({ collection: "now", taskId: null });
    await byId("shell.go_archive").run(env);
    await byId("shell.go_settings").run(env);
    expect(shell.revealInbox).not.toHaveBeenCalled();
  });

  it("opens the Vault with a full document navigation", async () => {
    const { env, services } = environment({ collection: "now", taskId: null });
    await byId("shell.go_vault").run(env);
    expect(services.assign).toHaveBeenCalledWith("/vault");
    expect(services.navigate).not.toHaveBeenCalled();
  });

  it("focuses panes through the shell and explains when a task is needed", async () => {
    const onCollection = environment({ collection: "later", taskId: null });
    expect(byId("shell.focus_page").availability(onCollection.env)).toEqual({
      enabled: false,
      reason: "Open a task first",
    });
    expect(byId("shell.focus_inbox").availability(onCollection.env)).toEqual({ enabled: true });

    const onTask = environment({ collection: "later", taskId: "t1" });
    expect(byId("shell.focus_page").availability(onTask.env)).toEqual({ enabled: true });
    await byId("shell.focus_page").run(onTask.env);
    await byId("shell.focus_inbox").run(onTask.env);
    await byId("shell.toggle_inbox").run(onTask.env);
    expect(onTask.shell.focusPane).toHaveBeenNthCalledWith(1, "page");
    expect(onTask.shell.focusPane).toHaveBeenNthCalledWith(2, "inbox");
    expect(onTask.shell.toggleInbox).toHaveBeenCalledTimes(1);
  });

  it("disables pane actions outside the workspace", () => {
    const { env } = environment(null, false);
    for (const id of ["shell.focus_inbox", "shell.focus_page", "shell.toggle_inbox"]) {
      expect(byId(id).availability(env)).toEqual({
        enabled: false,
        reason: "Available in the task workspace",
      });
    }
  });

  it("binds the note 13 navigation sequences", () => {
    expect(
      Object.fromEntries(
        shellActions.filter((a) => a.defaultBinding).map((a) => [a.id, a.defaultBinding]),
      ),
    ).toEqual({
      "shell.go_now": "g n",
      "shell.go_later": "g l",
      "shell.go_unclassified": "g u",
      "shell.go_archive": "g a",
      "shell.go_settings": "g s",
      "shell.go_vault": "g v",
      "shell.focus_inbox": "g i",
      "shell.focus_page": "g d",
    });
  });
});
