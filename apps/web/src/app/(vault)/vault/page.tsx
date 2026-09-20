import { VaultScreen } from "@/features/vault/vault-screen";
export default async function VaultPage({
  searchParams,
}: {
  searchParams: Promise<{ add?: string }>;
}) {
  const { add } = await searchParams;
  return <VaultScreen addItem={add === "1"} />;
}
