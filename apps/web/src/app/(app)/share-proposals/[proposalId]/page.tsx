import { ShareProposalScreen } from "@/features/sharing/proposal-screen";
export default async function ProposalPage({
  params,
}: {
  params: Promise<{ proposalId: string }>;
}) {
  const { proposalId } = await params;
  return <ShareProposalScreen key={proposalId} proposalId={proposalId} />;
}
