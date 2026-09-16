import { ArchiveView } from "@/features/workspace/archive-view";

/** One archived record: its retained page and conversation, read only, with a calm Restore. */
export default async function ArchivedTaskPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;
  return <ArchiveView taskId={taskId} />;
}
