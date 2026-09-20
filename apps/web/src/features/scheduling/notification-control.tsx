"use client";
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { workspaceRealtimeSource } from "@/features/workspace/realtime";
import { NotificationCenter } from "./notification-center.tsx";
import { useScheduling } from "./provider.tsx";

/** The top-bar notification entry, sharing the workspace's single user subscription. */
export function NotificationControl() {
  const scheduling = useScheduling();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [summary, setSummary] = useState(0);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("symplist:notifications", show);
    const unsubscribe = workspaceRealtimeSource()?.subscribeUser({
      onSnapshot: (event) => {
        if (
          typeof event.data === "object" &&
          event.data !== null &&
          "unreadCount" in event.data &&
          typeof event.data.unreadCount === "number"
        ) {
          setCount(event.data.unreadCount);
          setRevision((value) => value + 1);
        }
      },
      onEvent: (event) => {
        if (typeof event.data !== "object" || event.data === null) return;
        if (
          event.type === "notifications.changed" &&
          "unreadCount" in event.data &&
          typeof event.data.unreadCount === "number"
        ) {
          setCount(event.data.unreadCount);
          setRevision((value) => value + 1);
        }
        if (
          event.type === "notifications.summary" &&
          "count" in event.data &&
          typeof event.data.count === "number"
        )
          setSummary(event.data.count);
      },
    });
    return () => {
      window.removeEventListener("symplist:notifications", show);
      unsubscribe?.();
    };
  }, []);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-lg"
        className="sym-notification-control"
        aria-label={`Notifications${count ? `, ${count} unread` : ""}`}
        onClick={() => {
          setOpen(true);
          setSummary(0);
        }}
      >
        <Bell size={16} aria-hidden="true" />
        {count ? <span className="sym-notification-dot" aria-hidden="true" /> : null}
      </Button>
      {summary ? (
        <span className="sym-notification-summary" role="status">
          {summary} reminders during quiet hours
        </span>
      ) : null}
      {open && scheduling ? (
        <NotificationCenter
          api={scheduling.api}
          onClose={() => setOpen(false)}
          onUnread={setCount}
          refreshRevision={revision}
        />
      ) : null}
    </>
  );
}
