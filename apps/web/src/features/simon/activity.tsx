import type { VisiblePart } from "./projection.ts";

const labels: Readonly<Record<string, string>> = {
  task_context: "Checking task context",
  rules_read: "Checking workspace guidance",
  task_document_outline: "Checking the page outline",
  task_document_search: "Finding a section",
  task_document_read_section: "Reading a section",
  task_document_update_section: "Updating a section",
  task_document_changes: "Checking changes since last read",
  task_document_diff: "Comparing page versions",
  task_document_history: "Checking page history",
  task_document_restore: "Restoring a page version",
  task_create: "Creating a task",
  task_move: "Moving a task",
  task_schedule: "Updating the schedule",
  search_tools: "Finding connected capabilities",
  get_tool_schemas: "Checking action details",
  execute_tools: "Using a connected service",
  manage_connections: "Checking service connections",
  user_ask: "Asking a question",
  handoff_prepare: "Preparing a specialist handoff",
  artifact_snapshot: "Preparing an artifact",
  artifact_share_create: "Proposing a share",
  artifact_share_list: "Checking artifact links",
  artifact_share_revoke: "Revoking a link",
};
export function Activity({ part }: { part: VisiblePart }) {
  if (part.type === "text") return null;
  if (part.type === "data-approval-result")
    return (
      <p role="status">
        {part.data.status === "uncertain"
          ? "The action’s outcome could not be confirmed. Check the connected service before trying another action."
          : `Action ${part.data.status}.`}
      </p>
    );
  if (part.type === "data-user-answer")
    return (
      <p className="sym-simon-note">
        {part.data.status === "answered"
          ? "Your answer was received."
          : `Question ${part.data.status}.`}
      </p>
    );
  return (
    <details className="sym-simon-tool">
      <summary>
        {labels[part.toolName] ?? "Working with a connected service"} ·{" "}
        {part.state === "input-available"
          ? "In progress"
          : part.state === "output-error"
            ? "Could not complete"
            : "Done"}
      </summary>
      <p>
        {part.state === "output-error"
          ? "This step failed. Completed external actions are not automatically repeated."
          : "Simon uses bounded task context. Hidden reasoning and raw action arguments are not shown here."}
      </p>
    </details>
  );
}
