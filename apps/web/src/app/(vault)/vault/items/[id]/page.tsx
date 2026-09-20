import { VaultScreen } from "@/features/vault/vault-screen";
export default async function VaultItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VaultScreen itemId={id} />;
}
