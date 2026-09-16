import type { AppAction } from "@/actions/types";

/** Actions contributed by the vault feature to the command registry (§10.2). */
export const vaultActions: readonly AppAction[] = [
  {
    id: "vault.add_item",
    label: "Add vault item",
    context: "app",
    group: "general",
    keywords: ["secret", "secure note"],
    availability: () => ({ enabled: true }),
    run: ({ services }) => services.assign("/vault?add=1"),
  },
  {
    id: "vault.lock",
    label: "Lock vault",
    context: "app",
    group: "general",
    availability: () => ({ enabled: true }),
    run: async ({ services }) => {
      const { getVaultApi } = await import("./api");
      await getVaultApi().lock();
      services.announce("Vault locked");
    },
  },
];
