"use client";

import {
  type AdminEvent,
  type AdminEventAction,
  adminEventActions,
  type ListActivityQuery,
} from "@symplist/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAccessApi } from "../../api.ts";
import { type AccessProblem, genericProblemMessage, problemOf } from "../../errors.ts";
import { inputClassName } from "../../ui/field.tsx";
import { endOfLocalDay, formatDateTime, toDateInputValue } from "../../ui/format.ts";
import { Notice } from "../../ui/notice.tsx";
import {
  actorName,
  eventActionFilterLabels,
  eventResult,
  eventSentence,
  formatEventValue,
  targetName,
} from "../labels.ts";
import { idParam, inviteIdParam } from "../query-ids.ts";
import {
  AdminEmpty,
  AdminFailed,
  AdminHeader,
  AdminLoading,
  Cell,
  DataTable,
  HeadCell,
  LoadMore,
  Row,
} from "../ui.tsx";
import { useResource } from "../use-resource.ts";

interface DetailState {
  readonly status: "loading" | "ready" | "failed";
  readonly reason?: string | null;
  readonly reasonUnavailable?: boolean;
  readonly problem?: AccessProblem;
}

function startOfLocalDay(value: string): number | null {
  const end = endOfLocalDay(value);
  return end === null ? null : end - 86_399_999;
}

/**
 * The access activity log (admin_activity.md): an immutable, newest-first record of what was done to
 * invites and accounts. Rows expand to the recorded reason and before/after values. It tracks invite
 * seats and access decisions — never model usage, credits or quotas — and shows code hints only.
 */
export function ActivityLog() {
  const api = useAccessApi();
  const router = useRouter();
  const params = useSearchParams();
  const accountId = idParam(params.get("accountId"));
  const inviteId = inviteIdParam(params.get("inviteId"));
  const campaignId = idParam(params.get("campaignId"));
  const [action, setAction] = useState<AdminEventAction | "all">(
    (params.get("action") as AdminEventAction | null) ?? "all",
  );
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [to, setTo] = useState(params.get("to") ?? "");
  const [more, setMore] = useState<readonly AdminEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Readonly<Record<string, DetailState>>>({});

  const query = useMemo<ListActivityQuery>(() => {
    const fromMs = from ? startOfLocalDay(from) : null;
    const toMs = to ? endOfLocalDay(to) : null;
    return {
      ...(action === "all" ? {} : { action }),
      ...(accountId ? { accountId } : {}),
      ...(inviteId ? { inviteId } : {}),
      ...(campaignId ? { campaignId } : {}),
      ...(fromMs === null ? {} : { from: fromMs }),
      ...(toMs === null ? {} : { to: toMs }),
    };
  }, [action, accountId, inviteId, campaignId, from, to]);

  const load = useCallback(
    (signal: AbortSignal) => {
      setMore([]);
      setCursor(null);
      return api.listActivity(query, signal);
    },
    [api, query],
  );
  const page = useResource(JSON.stringify(query), load);
  const events = useMemo(() => [...(page.data?.items ?? []), ...more], [page.data, more]);
  const nextCursor = cursor ?? page.data?.nextCursor ?? null;
  const filtered =
    action !== "all" || from !== "" || to !== "" || accountId || inviteId || campaignId;

  const updateAddress = (next: {
    action?: AdminEventAction | "all";
    from?: string;
    to?: string;
  }) => {
    const search = new URLSearchParams(params.toString());
    const nextAction = next.action ?? action;
    if (nextAction === "all") search.delete("action");
    else search.set("action", nextAction);
    for (const [key, value] of [
      ["from", next.from ?? from],
      ["to", next.to ?? to],
    ] as const) {
      if (value) search.set(key, value);
      else search.delete(key);
    }
    const text = search.toString();
    router.replace(text ? `/admin/activity?${text}` : "/admin/activity");
  };

  const applyDates = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    updateAddress({});
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.listActivity({ ...query, cursor: nextCursor });
      setMore((current) => [...current, ...next.items]);
      setCursor(next.nextCursor);
    } catch {
      // Keep what is on screen.
    } finally {
      setLoadingMore(false);
    }
  };

  const toggle = async (event: AdminEvent) => {
    if (expanded === event.id) {
      setExpanded(null);
      return;
    }
    setExpanded(event.id);
    if (details[event.id]?.status === "ready") return;
    setDetails((current) => ({ ...current, [event.id]: { status: "loading" } }));
    try {
      const detail = await api.activityDetail(event.id);
      setDetails((current) => ({
        ...current,
        [event.id]: {
          status: "ready",
          reason: detail.reason,
          reasonUnavailable: detail.reasonUnavailable,
        },
      }));
    } catch (error) {
      setDetails((current) => ({
        ...current,
        [event.id]: { status: "failed", problem: problemOf(error) },
      }));
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <AdminHeader
        title="Activity"
        description="Every beta access operation, newest first. Records can't be edited or removed."
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="activity-action" className="font-medium text-[13px]">
              Action
            </label>
            <select
              id="activity-action"
              className={`${inputClassName} w-[220px]`}
              value={action}
              onChange={(event) => {
                const value = event.target.value as AdminEventAction | "all";
                setAction(value);
                updateAddress({ action: value });
              }}
            >
              <option value="all">Every action</option>
              {adminEventActions.map((value) => (
                <option key={value} value={value}>
                  {eventActionFilterLabels[value]}
                </option>
              ))}
            </select>
          </div>
          <form className="flex flex-wrap items-end gap-3" onSubmit={applyDates}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="activity-from" className="font-medium text-[13px]">
                From
              </label>
              <input
                id="activity-from"
                type="date"
                className={`${inputClassName} w-[170px]`}
                value={from}
                max={toDateInputValue(Date.now())}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="activity-to" className="font-medium text-[13px]">
                To
              </label>
              <input
                id="activity-to"
                type="date"
                className={`${inputClassName} w-[170px]`}
                value={to}
                max={toDateInputValue(Date.now())}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
            <Button type="submit" size="lg">
              Apply dates
            </Button>
          </form>
          {filtered ? (
            <Button
              variant="ghost"
              size="lg"
              onClick={() => {
                setAction("all");
                setFrom("");
                setTo("");
                router.replace("/admin/activity");
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
        {accountId || inviteId || campaignId ? (
          <p className="m-0 text-[13px] text-sym-muted">
            Showing events for one {accountId ? "account" : inviteId ? "invite" : "campaign"} only.{" "}
            <Link
              className="text-sym-link underline-offset-2 hover:underline"
              href="/admin/activity"
            >
              Show everything
            </Link>
          </p>
        ) : null}
      </div>

      {page.status === "loading" ? <AdminLoading label="Loading activity" /> : null}
      {page.status === "failed" && page.problem ? (
        <AdminFailed
          title="Couldn't load activity"
          problem={page.problem}
          onRetry={() => page.reload()}
        />
      ) : null}
      {page.status === "ready" && events.length === 0 ? (
        filtered ? (
          <AdminEmpty
            title="No events match these filters"
            description="Try a wider date range or another action."
          />
        ) : (
          <AdminEmpty
            title="Nothing has happened yet"
            description="Generating codes, redemptions and access changes all appear here."
          />
        )
      ) : null}

      {events.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Beta access activity, newest first</caption>
          <thead>
            <tr>
              <HeadCell>Time</HeadCell>
              <HeadCell>Actor</HeadCell>
              <HeadCell>What happened</HeadCell>
              <HeadCell>Target</HeadCell>
              <HeadCell>Result</HeadCell>
              <HeadCell>
                <span className="sr-only">Details</span>
              </HeadCell>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const detail = details[event.id];
              const open = expanded === event.id;
              return (
                <Row key={event.id}>
                  <Cell label="Time">{formatDateTime(event.createdAt)}</Cell>
                  <Cell label="Actor">{actorName(event)}</Cell>
                  <Cell label="What happened">{eventSentence(event)}</Cell>
                  <Cell label="Target">
                    {event.target.kind === "user" && event.target.id ? (
                      <Link
                        className="text-sym-link underline-offset-2 hover:underline"
                        href={`/admin/accounts/${event.target.id}`}
                      >
                        {targetName(event) ?? "Account"}
                      </Link>
                    ) : event.target.kind === "invite" && event.target.id ? (
                      <Link
                        className="text-sym-link underline-offset-2 hover:underline"
                        href={`/admin/invites/${event.target.id}`}
                      >
                        {targetName(event) ?? "Invite"}
                      </Link>
                    ) : (
                      (targetName(event) ?? "—")
                    )}
                  </Cell>
                  <Cell label="Result">{eventResult(event)}</Cell>
                  <Cell label="Details" colSpan={1}>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={open}
                      onClick={() => {
                        void toggle(event);
                      }}
                    >
                      {open ? "Hide details" : "Details"}
                    </Button>
                    {open ? (
                      <div className="mt-2 flex flex-col gap-1.5 rounded-sym border border-sym-line bg-sym-surface p-2.5 text-[13px]">
                        {detail?.status === "loading" ? (
                          <p role="status" className="m-0 flex items-center gap-2 text-sym-muted">
                            <Spinner size={11} /> Loading the recorded reason…
                          </p>
                        ) : null}
                        {detail?.status === "failed" && detail.problem ? (
                          <Notice tone="error">{genericProblemMessage(detail.problem)}</Notice>
                        ) : null}
                        {detail?.status === "ready" ? (
                          <p className="m-0">
                            <span className="text-sym-muted">Reason: </span>
                            {detail.reasonUnavailable
                              ? "Recorded, but no longer readable — the account it belonged to was deleted."
                              : (detail.reason ?? "None recorded.")}
                          </p>
                        ) : null}
                        {event.campaign ? (
                          <p className="m-0">
                            <span className="text-sym-muted">Campaign: </span>
                            <Link
                              className="text-sym-link underline-offset-2 hover:underline"
                              href={`/admin/invites?campaignId=${encodeURIComponent(event.campaign.id)}`}
                            >
                              {event.campaign.label ?? "This batch of codes"}
                            </Link>
                          </p>
                        ) : null}
                        <p className="m-0">
                          <span className="text-sym-muted">Before: </span>
                          {event.before
                            ? Object.entries(event.before)
                                .map(([key, value]) => `${key} ${formatEventValue(value)}`)
                                .join(", ")
                            : "—"}
                        </p>
                        <p className="m-0">
                          <span className="text-sym-muted">After: </span>
                          {event.after
                            ? Object.entries(event.after)
                                .map(([key, value]) => `${key} ${formatEventValue(value)}`)
                                .join(", ")
                            : "—"}
                        </p>
                      </div>
                    ) : null}
                  </Cell>
                </Row>
              );
            })}
          </tbody>
        </DataTable>
      ) : null}

      {nextCursor ? <LoadMore busy={loadingMore} onClick={() => void loadMore()} /> : null}
    </div>
  );
}
