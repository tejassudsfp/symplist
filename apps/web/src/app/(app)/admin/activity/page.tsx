import { Suspense } from "react";
import { ActivityLog } from "@/features/access/admin/activity/activity-log";

export default function AdminActivityPage() {
  return (
    <Suspense fallback={<p className="text-[13.5px] text-sym-muted">Loading activity…</p>}>
      <ActivityLog />
    </Suspense>
  );
}
