import Link from "next/link";
import { RouteState } from "@/components/ui/route-state";

export default function NotFound() {
  return (
    <main className="sym-route-state-shell">
      <RouteState
        title="Page not found"
        description="This address isn’t available. Private task names and account details are never shown here."
        action={<Link href="/now">Return to tasks</Link>}
      />
    </main>
  );
}
