import { Suspense } from "react";
import { AccountList } from "@/features/access/admin/accounts/account-list";

export default function AccountsPage() {
  return (
    <Suspense fallback={<p className="text-[13.5px] text-sym-muted">Loading accounts…</p>}>
      <AccountList />
    </Suspense>
  );
}
