import { AccountDetail } from "@/features/access/admin/accounts/account-detail";

export default async function AccountDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AccountDetail userId={id} />;
}
