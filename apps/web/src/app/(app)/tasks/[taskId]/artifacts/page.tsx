import { TaskArtifactsScreen } from "@/features/documents/artifacts-screen";

/**
 * A task's artifacts and links (artifact_shares.md). Like the history route it sits outside the
 * workspace route groups and carries a validated `from` naming the task page it was entered from.
 */
export default async function ArtifactSharesPage({
  params,
  searchParams,
}: {
  params: Promise<{ taskId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { taskId } = await params;
  const query = await searchParams;
  const from = Array.isArray(query.from) ? query.from[0] : query.from;
  return <TaskArtifactsScreen taskId={taskId} from={from ?? null} />;
}
