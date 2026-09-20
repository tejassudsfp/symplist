import { DocumentHistoryScreen } from "@/features/documents/history-screen";

/**
 * A task's document revisions (document_history.md). It sits outside the workspace route groups, so
 * the shell renders it as a plain page: a secondary surface with a clear Back to page action rather
 * than a fourth panel. `from` names the task page it was entered from and is validated before use.
 */
export default async function DocumentHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ taskId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { taskId } = await params;
  const query = await searchParams;
  const from = Array.isArray(query.from) ? query.from[0] : query.from;
  return <DocumentHistoryScreen taskId={taskId} from={from ?? null} />;
}
