"use client";

import { taskCollectionSchema, taskIdSchema } from "@symplist/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "@/features/access/session";
import { useQueryParam } from "@/features/access/ui/use-query-param";

interface ReturnTask {
  readonly taskId: string;
  readonly collection: "now" | "later" | "unclassified";
}
function parse(value: unknown): ReturnTask | null {
  if (!value || typeof value !== "object") return null;
  const task = taskIdSchema.safeParse("taskId" in value ? value.taskId : undefined);
  const collection = taskCollectionSchema.safeParse(
    "collection" in value ? value.collection : undefined,
  );
  return task.success && collection.success
    ? { taskId: task.data, collection: collection.data }
    : null;
}

/** Only owner-scoped navigation ids survive the provider handoff — never catalogue or credentials. */
export function ConnectionReturnTask() {
  const { user, access } = useSession();
  const task = useQueryParam("task");
  const collection = useQueryParam("collection");
  const key = user ? `symplist.connections.return.${user.id}.${access?.accessGeneration}` : null;
  const [context, setContext] = useState<ReturnTask | null>(null);
  useEffect(() => {
    if (!key) {
      setContext(null);
      return;
    }
    const incoming = parse({ taskId: task, collection: collection ?? "now" });
    try {
      if (incoming) {
        window.sessionStorage.setItem(key, JSON.stringify(incoming));
        setContext(incoming);
      } else setContext(parse(JSON.parse(window.sessionStorage.getItem(key) ?? "null")));
    } catch {
      setContext(incoming);
    }
  }, [key, task, collection]);
  if (!context) return null;
  return (
    <Link
      href={`/${context.collection}/${context.taskId}`}
      onClick={() => {
        try {
          if (key) window.sessionStorage.removeItem(key);
        } catch {
          /* Navigation still works without storage. */
        }
      }}
    >
      Return to task — review the pending action there
    </Link>
  );
}
