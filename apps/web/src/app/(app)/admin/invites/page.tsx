import { Suspense } from "react";
import { InviteInventory } from "@/features/access/admin/invites/invite-inventory";

export default function InvitesPage() {
  return (
    <Suspense fallback={<p className="text-[13.5px] text-sym-muted">Loading invites…</p>}>
      <InviteInventory />
    </Suspense>
  );
}
