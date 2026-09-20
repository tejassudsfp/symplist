"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { createWorkspaceApi, type WorkspaceApi } from "./api.ts";

/** Collection-independent links remain valid after a task moves or is archived. No caller supplies its owner. */
export function TaskDeepLink({
  taskId,
  api: provided,
}: {
  taskId: string;
  api?: Pick<WorkspaceApi, "getTask">;
}) {
  const api = useMemo(() => provided ?? createWorkspaceApi(), [provided]);
  const router = useRouter();
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    void revision;
    let current = true;
    setError(false);
    void api
      .getTask(taskId)
      .then(({ task }) => {
        if (current)
          router.replace(
            task.status === "archived" ? `/archive/${task.id}` : `/${task.collection}/${task.id}`,
          );
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
    };
  }, [api, taskId, router, revision]);
  return (
    <section className="sym-schedule-empty">
      {error ? (
        <>
          <h1>Task unavailable</h1>
          <p role="alert">
            This task may no longer be available, or your connection was interrupted.
          </p>
          <Button onClick={() => setRevision((value) => value + 1)}>Try again</Button>
          <Button onClick={() => router.replace("/now")}>Back to Now</Button>
        </>
      ) : (
        <p role="status">Opening task…</p>
      )}
    </section>
  );
}
