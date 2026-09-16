import { InviteDetail } from "@/features/access/admin/invites/invite-detail";

export default async function InviteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InviteDetail inviteId={id} />;
}
