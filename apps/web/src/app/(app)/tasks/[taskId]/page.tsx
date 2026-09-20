import { TaskDeepLink } from "@/features/workspace/task-deep-link";

/** Stable reminder links resolve the task's current collection after authentication and admission. */
export default async function TaskLinkPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  return <TaskDeepLink taskId={taskId} />;
}
