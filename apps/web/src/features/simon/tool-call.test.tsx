import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PermissionCard } from "./permission-card.tsx";
import type { ChatToolCall } from "./projection.ts";
import { fakePermission } from "./test-support.ts";
import { ToolCallCard } from "./tool-call.tsx";
import { argumentSummary, commandOf, isSymplistTool, toolLabel } from "./tool-labels.ts";

/*
 * The label table carries the consequence of a fact about the wire: `dsh-acp` hardcodes `kind: "other"`
 * on every tool call and puts the tool's programmatic name in `title`. So ACP's tool kind — the field a
 * client is meant to pick an icon from — says nothing, and the name is the only thing to go on.
 */
const call = (over: Partial<ChatToolCall> = {}): ChatToolCall => ({
  kind: "tool",
  toolCallId: "c1",
  name: "bash",
  toolKind: "other",
  status: "in_progress",
  content: [],
  locations: [],
  rawInput: { command: "pnpm lint" },
  rawOutput: undefined,
  ...over,
});

describe("tool labels", () => {
  it("names all thirteen Symplist tools, with or without the MCP prefix", () => {
    const names = [
      "task_list",
      "task_create",
      "task_move",
      "task_search",
      "task_context",
      "task_document_outline",
      "task_document_read_section",
      "task_document_update_section",
      "task_document_restore",
      "task_document_history",
      "task_document_diff",
      "task_document_changes",
      "task_document_search",
    ];
    for (const name of names) {
      expect(isSymplistTool(name)).toBe(true);
      expect(isSymplistTool(`mcp__symplist__${name}`)).toBe(true);
      // The label is a sentence in the app's voice, never the raw name.
      expect(toolLabel(`mcp__symplist__${name}`).label).not.toBe(name);
    }
    expect(toolLabel("mcp__symplist__task_document_update_section")).toEqual({
      label: "Updating a section",
      icon: "edit",
    });
  });

  it("recognises the harness's shell tools however the release spells them", () => {
    for (const name of ["bash", "run_shell", "shell", "Bash"])
      expect(toolLabel(name)).toEqual({ label: "Running a command", icon: "execute" });
    // Longest pattern first, so a file read never loses to a bare "read".
    expect(toolLabel("read_file").label).toBe("Reading a file");
  });

  it("uses a tool's own name rather than inventing a label for it", () => {
    // A confident guess would tell the person something about what the agent did that is not known.
    expect(toolLabel("some_future_plugin_tool")).toEqual({
      label: "some_future_plugin_tool",
      icon: "other",
    });
    expect(isSymplistTool("some_future_plugin_tool")).toBe(false);
  });

  it("reads the command out of rawInput, which is where the harness puts parsed arguments", () => {
    expect(commandOf({ command: "pnpm test" })).toBe("pnpm test");
    expect(commandOf({ cmd: ["ls", "-la"] })).toBe("ls -la");
    expect(commandOf({ heading: "Next steps" })).toBeNull();
    expect(commandOf(null)).toBeNull();
    expect(commandOf("ls")).toBeNull();
  });

  it("summarises an argument only when there is something short and true to say", () => {
    expect(argumentSummary("read_file", { path: "/a/b.md" })).toBe("/a/b.md");
    expect(argumentSummary("task_search", { query: "outline" })).toBe("outline");
    expect(argumentSummary("task_list", { limit: 20 })).toBeNull();
  });
});

describe("the tool call card", () => {
  it("shows a command and its output, and stays open while it runs", () => {
    render(<ToolCallCard call={call()} />);
    expect(screen.getByText("Running a command")).toBeTruthy();
    // Twice: once truncated in the summary line, once in full inside the card.
    expect(screen.getAllByText("pnpm lint")).toHaveLength(2);
    expect(screen.getByText("No output yet.")).toBeTruthy();
    expect(screen.getByRole("group")).toHaveProperty("open", true);
  });

  it("folds a finished call away and keeps a failed one open", () => {
    const { unmount } = render(
      <ToolCallCard
        call={call({
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "no problems" } }],
        })}
      />,
    );
    expect(screen.getByRole("group")).toHaveProperty("open", false);
    expect(screen.getByText("Done")).toBeTruthy();
    unmount();
    render(<ToolCallCard call={call({ status: "failed" })} />);
    expect(screen.getByRole("group")).toHaveProperty("open", true);
    expect(screen.getByText(/failed and reported nothing/)).toBeTruthy();
  });

  it("names the files a call touched", () => {
    render(
      <ToolCallCard
        call={call({
          name: "edit_file",
          rawInput: { path: "/repo/src/a.ts" },
          locations: [{ path: "/repo/src/a.ts", line: 12 }],
        })}
      />,
    );
    expect(screen.getByText("/repo/src/a.ts:12")).toBeTruthy();
  });

  it("says a Symplist call went through the workspace under the permissions granted", () => {
    render(
      <ToolCallCard
        call={call({
          name: "mcp__symplist__task_document_update_section",
          rawInput: { heading: "Next steps" },
        })}
      />,
    );
    expect(screen.getByText(/under the permissions you granted/)).toBeTruthy();
  });
});

describe("the permission card", () => {
  it("renders one button per offered option, in order, and never invents an 'always'", () => {
    render(
      <PermissionCard
        request={fakePermission("c1")}
        subject={call()}
        busy={false}
        onAnswer={() => {}}
      />,
    );
    const region = screen.getByRole("region", { name: /permission/ });
    expect(
      within(region)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Allow once", "Reject"]);
    expect(within(region).getByText(/asks again next time/)).toBeTruthy();
  });

  it("says it does not know the subject yet rather than describing the wrong thing", () => {
    // The harness's request carries only a toolCallId, so a card that cannot join it must say so.
    render(
      <PermissionCard
        request={fakePermission("missing")}
        subject={null}
        busy={false}
        onAnswer={() => {}}
      />,
    );
    expect(screen.getByText(/has not described yet/)).toBeTruthy();
  });

  it("refuses to answer twice while the answer is in flight", () => {
    render(
      <PermissionCard request={fakePermission("c1")} subject={call()} busy onAnswer={() => {}} />,
    );
    for (const button of screen.getAllByRole("button"))
      expect(button).toHaveProperty("disabled", true);
  });
});
