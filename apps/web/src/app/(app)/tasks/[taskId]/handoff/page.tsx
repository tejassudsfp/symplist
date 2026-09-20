import { HandoffScreen } from "@/features/sharing/handoff-screen";
export default async function HandoffPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  return <HandoffScreen key={taskId} taskId={taskId} />;
}
