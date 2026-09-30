/**
 * What a tool call is called, in the app's voice, and which icon it gets.
 *
 * This table exists because of one fact about the wire: `dsh-acp` sets `kind: "other"` on every
 * `tool_call` it emits and puts the tool's *programmatic* name in `title`. So ACP's tool kind — the
 * field a client is supposed to pick an icon from — carries no information here, and both the icon and
 * the label have to be derived from the name. Branching on `kind` would give every call the same icon.
 *
 * The Symplist entries are the thirteen incoming MCP tools, worded the way the cloud chat worded them
 * before phase 1 deleted it. The harness's own tools are named the way the harness names them, and are
 * matched loosely because that list is not ours and grows without asking us.
 *
 * A tool nobody here recognises gets its own name and the neutral icon, never a guess: an invented label
 * would tell the person something about what the agent did that we do not actually know.
 */

/** Which icon a call draws. Mapped to lucide icons in `tool-call.tsx`. */
export type ToolIcon = "read" | "edit" | "search" | "execute" | "task" | "history" | "other";

interface ToolLabel {
  readonly label: string;
  readonly icon: ToolIcon;
}

/** The prefix an MCP tool carries when the harness mounts a server named `symplist`. */
const mcpPrefix = "mcp__symplist__";

const symplistTools: Readonly<Record<string, ToolLabel>> = {
  task_list: { label: "Reading your task list", icon: "read" },
  task_create: { label: "Creating a task", icon: "task" },
  task_move: { label: "Moving a task", icon: "task" },
  task_search: { label: "Searching your tasks", icon: "search" },
  task_context: { label: "Checking task context", icon: "read" },
  task_document_outline: { label: "Checking the page outline", icon: "read" },
  task_document_read_section: { label: "Reading a section", icon: "read" },
  task_document_update_section: { label: "Updating a section", icon: "edit" },
  task_document_restore: { label: "Restoring a page version", icon: "history" },
  task_document_history: { label: "Checking page history", icon: "history" },
  task_document_diff: { label: "Comparing page versions", icon: "history" },
  task_document_changes: { label: "Checking changes since last read", icon: "history" },
  task_document_search: { label: "Finding a section", icon: "search" },
};

/**
 * The harness's own tools. Matched by substring because their names vary by dsh release and because
 * several of them are spelled differently on different providers — `bash`, `run_shell`, `shell`.
 * Longest pattern first, so `read_file` never loses to `read`.
 */
const harnessTools: readonly (readonly [string, ToolLabel])[] = [
  ["update_file", { label: "Editing a file", icon: "edit" }],
  ["write_file", { label: "Writing a file", icon: "edit" }],
  ["edit_file", { label: "Editing a file", icon: "edit" }],
  ["read_file", { label: "Reading a file", icon: "read" }],
  ["list_dir", { label: "Listing a directory", icon: "read" }],
  ["run_shell", { label: "Running a command", icon: "execute" }],
  ["glob", { label: "Finding files", icon: "search" }],
  ["grep", { label: "Searching the files", icon: "search" }],
  ["bash", { label: "Running a command", icon: "execute" }],
  ["shell", { label: "Running a command", icon: "execute" }],
  ["fetch", { label: "Fetching a page", icon: "other" }],
  ["todo", { label: "Keeping its own notes", icon: "other" }],
];

/** The Symplist tool a name refers to, with the MCP prefix stripped, or null for anything else. */
export function symplistToolName(name: string): string | null {
  const bare = name.startsWith(mcpPrefix) ? name.slice(mcpPrefix.length) : name;
  return bare in symplistTools ? bare : null;
}

/** Whether a call reached the cloud through Symplist's own MCP server. */
export function isSymplistTool(name: string): boolean {
  return symplistToolName(name) !== null;
}

/** The label and icon for a tool name. */
export function toolLabel(name: string): ToolLabel {
  const bare = symplistToolName(name);
  if (bare) {
    const known = symplistTools[bare];
    if (known) return known;
  }
  const lower = name.toLowerCase();
  for (const [pattern, label] of harnessTools) if (lower.includes(pattern)) return label;
  // Not a guess and not a shrug: the name the harness used, which is the only true thing available.
  return { label: name, icon: "other" };
}

/**
 * The shell command a call is about to run, when it plainly is one.
 *
 * `dsh-acp` puts the tool's parsed JSON arguments in `rawInput`, so for a shell tool the command is
 * there verbatim — which is what makes "the agent ran a command" a card a person can actually read, and
 * what makes a permission prompt about it answerable. Several argument names are accepted because the
 * key depends on the harness's tool definition, not on us.
 */
export function commandOf(rawInput: unknown): string | null {
  if (typeof rawInput !== "object" || rawInput === null) return null;
  const record = rawInput as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "shell_command"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    // Some tool definitions take argv rather than a line. Joining is a display convenience only.
    if (Array.isArray(value) && value.every((part) => typeof part === "string") && value.length)
      return value.join(" ");
  }
  return null;
}

/**
 * The shortest true description of a call's arguments for the collapsed card, or null when there is
 * nothing short to say. A command wins; otherwise a single string argument that reads like a path or a
 * heading is worth showing, and a whole JSON object is not.
 */
export function argumentSummary(name: string, rawInput: unknown): string | null {
  const command = commandOf(rawInput);
  if (command) return command;
  if (typeof rawInput !== "object" || rawInput === null) return null;
  const record = rawInput as Record<string, unknown>;
  for (const key of ["path", "file_path", "heading", "section", "query", "pattern", "title"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  void name;
  return null;
}
