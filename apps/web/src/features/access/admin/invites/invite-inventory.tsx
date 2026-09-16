"use client";

import {
  type AdminInvite,
  formatInviteHint,
  type InviteStatus,
  inviteStatuses,
  type ListInvitesQuery,
} from "@symplist/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { IdempotencyKeys } from "@/lib/api";
import { useAccessApi } from "../../api.ts";
import { problemOf } from "../../errors.ts";
import { inputClassName } from "../../ui/field.tsx";
import { formatDate } from "../../ui/format.ts";
import { Notice } from "../../ui/notice.tsx";
import { inviteStatusLabels } from "../labels.ts";
import { idParam } from "../query-ids.ts";
import {
  AdminEmpty,
  AdminFailed,
  AdminHeader,
  AdminLoading,
  Cell,
  DataTable,
  FilterChips,
  HeadCell,
  LoadMore,
  Row,
} from "../ui.tsx";
import { useResource } from "../use-resource.ts";

type StatusFilter = InviteStatus | "all";

const statusOptions: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  ...inviteStatuses.map((status) => ({ value: status, label: inviteStatusLabels[status] })),
];

interface RevocationOutcome {
  readonly revoked: number;
  readonly unchanged: number;
  readonly failed: number;
}

/**
 * The invite inventory (admin_invites.md): label or campaign, the short code hint, status, seats used
 * of the cap, expiry and creation date. Full codes are never recoverable here — only the hint, which
 * is not secret. Revoking stops future redemptions and never takes access from admitted accounts.
 */
export function InviteInventory() {
  const api = useAccessApi();
  const router = useRouter();
  const params = useSearchParams();
  const campaignId = idParam(params.get("campaignId"));
  const [status, setStatus] = useState<StatusFilter>(
    (params.get("status") as StatusFilter | null) ?? "all",
  );
  const [searchDraft, setSearchDraft] = useState(params.get("q") ?? "");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [pages, setPages] = useState<readonly AdminInvite[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [outcome, setOutcome] = useState<RevocationOutcome | null>(null);
  const keys = useMemo(() => new IdempotencyKeys(), []);

  const query = useMemo<ListInvitesQuery>(
    () => ({
      ...(status === "all" ? {} : { status }),
      ...(search ? { q: search } : {}),
      ...(campaignId ? { campaignId } : {}),
    }),
    [status, search, campaignId],
  );

  const key = JSON.stringify(query);
  const load = useCallback(
    (signal: AbortSignal) => {
      setPages([]);
      setCursor(null);
      setSelected(new Set());
      return api.listInvites(query, signal);
    },
    [api, query],
  );
  const page = useResource(key, load);

  const invites = useMemo(() => [...(page.data?.items ?? []), ...pages], [page.data, pages]);
  const nextCursor = cursor ?? page.data?.nextCursor ?? null;

  const updateAddress = (next: { status?: StatusFilter; q?: string }) => {
    const search = new URLSearchParams(params.toString());
    const nextStatus = next.status ?? status;
    const nextQuery = next.q ?? searchDraft;
    if (nextStatus === "all") search.delete("status");
    else search.set("status", nextStatus);
    if (nextQuery.trim() === "") search.delete("q");
    else search.set("q", nextQuery.trim());
    const text = search.toString();
    router.replace(text ? `/admin/invites?${text}` : "/admin/invites");
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearch(searchDraft.trim());
    updateAddress({ q: searchDraft });
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.listInvites({ ...query, cursor: nextCursor });
      setPages((current) => [...current, ...next.items]);
      setCursor(next.nextCursor);
    } catch {
      // The page keeps what it has; the button stays available for another try.
    } finally {
      setLoadingMore(false);
    }
  };

  const chosen = invites.filter((invite) => selected.has(invite.id));

  const revokeSelected = async () => {
    setRevoking(true);
    let revoked = 0;
    let unchanged = 0;
    let failed = 0;
    for (const invite of chosen) {
      try {
        await api.revokeInvite(
          invite.id,
          { expectedVersion: invite.version },
          keys.acquire(`revoke:${invite.id}:${invite.version}`),
        );
        revoked += 1;
      } catch (error) {
        const problem = problemOf(error);
        if (
          problem.kind === "api" &&
          (problem.code === "invite.revoked" || problem.code === "invite.changed")
        ) {
          unchanged += 1;
        } else failed += 1;
      }
    }
    setRevoking(false);
    setConfirmRevoke(false);
    setSelected(new Set());
    setOutcome({ revoked, unchanged, failed });
    page.reload();
  };

  return (
    <div className="flex flex-col gap-5">
      <AdminHeader
        title="Invites"
        description="Every code generated for this deployment. Codes themselves are shown once, when they are generated."
        actions={
          <Link
            className={buttonVariants({ variant: "primary", size: "lg" })}
            href="/admin/invites/new"
          >
            Generate codes
          </Link>
        }
      />

      <div className="flex flex-col gap-3">
        <FilterChips
          label="Filter invites by status"
          options={statusOptions}
          value={status}
          onChange={(value) => {
            setStatus(value);
            updateAddress({ status: value });
          }}
        />
        <search>
          <form className="flex flex-wrap gap-2" onSubmit={submitSearch}>
            <label className="sr-only" htmlFor="invite-search">
              Search invites by label, email or code hint
            </label>
            <input
              id="invite-search"
              className={`${inputClassName} max-w-[320px]`}
              type="search"
              placeholder="Label, bound email or code hint"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
            />
            <Button type="submit" size="lg">
              Search
            </Button>
            {search || campaignId ? (
              <Button
                variant="ghost"
                size="lg"
                onClick={() => {
                  setSearchDraft("");
                  setSearch("");
                  setStatus("all");
                  router.replace("/admin/invites");
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </form>
        </search>
        {campaignId ? (
          <p className="m-0 text-[13px] text-sym-muted">
            Showing one campaign only.{" "}
            <Link
              className="text-sym-link underline-offset-2 hover:underline"
              href="/admin/invites"
            >
              Show all invites
            </Link>
          </p>
        ) : null}
      </div>

      {outcome ? (
        <Notice tone={outcome.failed > 0 ? "warning" : "success"} title="Revocation finished">
          {`${outcome.revoked} revoked`}
          {outcome.unchanged > 0 ? `, ${outcome.unchanged} already revoked or changed` : ""}
          {outcome.failed > 0 ? `, ${outcome.failed} couldn't be revoked` : ""}. Accounts already
          admitted with these codes keep their access.
        </Notice>
      ) : null}

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-sym-lg border border-sym-line bg-sym-surface px-3 py-2">
          <span className="text-[13px]">{selected.size} selected</span>
          <Button size="sm" variant="danger" onClick={() => setConfirmRevoke(true)}>
            Revoke selected
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      ) : null}

      {page.status === "loading" ? <AdminLoading label="Loading invites" /> : null}
      {page.status === "failed" && page.problem ? (
        <AdminFailed
          title="Couldn't load invites"
          problem={page.problem}
          onRetry={() => page.reload()}
        />
      ) : null}
      {page.status === "ready" && invites.length === 0 ? (
        search || status !== "all" || campaignId ? (
          <AdminEmpty
            title="No invites match these filters"
            description="Try another status, or clear the search."
          />
        ) : (
          <AdminEmpty
            title="No invites yet"
            description="Generate codes when you have someone to share them with. Symplist never sends them itself."
          />
        )
      ) : null}

      {invites.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Invite codes with their status, use and expiry</caption>
          <thead>
            <tr>
              <HeadCell className="w-8">
                <span className="sr-only">Select</span>
              </HeadCell>
              <HeadCell>Label or campaign</HeadCell>
              <HeadCell>Code hint</HeadCell>
              <HeadCell>Status</HeadCell>
              <HeadCell>Use</HeadCell>
              <HeadCell>Expires</HeadCell>
              <HeadCell>Created</HeadCell>
              <HeadCell>
                <span className="sr-only">Details</span>
              </HeadCell>
            </tr>
          </thead>
          <tbody>
            {invites.map((invite) => (
              <Row key={invite.id}>
                <Cell label="Select">
                  <input
                    type="checkbox"
                    aria-label={`Select invite ${formatInviteHint(invite.hint)}`}
                    disabled={invite.revokedAt !== null}
                    checked={selected.has(invite.id)}
                    onChange={(event) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(invite.id);
                        else next.delete(invite.id);
                        return next;
                      });
                    }}
                  />
                </Cell>
                <Cell label="Label">
                  <span className="font-medium">{invite.label ?? "No label"}</span>
                  <span className="ml-2 text-[12px] text-sym-muted">
                    {invite.mode === "shared" ? "Shared campaign code" : "Independent code"}
                  </span>
                </Cell>
                <Cell label="Code hint">
                  <span className="font-mono text-[12.5px]">{formatInviteHint(invite.hint)}</span>
                </Cell>
                <Cell label="Status">{inviteStatusLabels[invite.status]}</Cell>
                <Cell label="Use">{`${invite.used} of ${invite.maxRedemptions}`}</Cell>
                <Cell label="Expires">{formatDate(invite.expiresAt)}</Cell>
                <Cell label="Created">{formatDate(invite.createdAt)}</Cell>
                <Cell label="Details">
                  <Link
                    className="text-sym-link underline-offset-2 hover:underline"
                    href={`/admin/invites/${invite.id}`}
                  >
                    {`View${invite.label ? ` ${invite.label}` : ` ${formatInviteHint(invite.hint)}`}`}
                  </Link>
                </Cell>
              </Row>
            ))}
          </tbody>
        </DataTable>
      ) : null}

      {nextCursor ? <LoadMore busy={loadingMore} onClick={() => void loadMore()} /> : null}

      <ConfirmDialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title={`Revoke ${chosen.length === 1 ? "this invite" : `${chosen.length} invites`}?`}
        description={
          <>
            Revoking stops any further redemption of{" "}
            {chosen.length === 1 ? "this code" : "these codes"}. People already admitted with them
            keep their access — relock an account in Accounts to take access away.
          </>
        }
        confirmLabel={revoking ? "Revoking…" : "Revoke"}
        busy={revoking}
        initialFocus="cancel"
        onConfirm={() => {
          void revokeSelected();
        }}
      >
        <ul className="m-0 max-h-[180px] list-none overflow-auto rounded-sym border border-sym-line p-2 text-[13px]">
          {chosen.map((invite) => (
            <li key={invite.id} className="flex justify-between gap-3 py-0.5">
              <span className="truncate">{invite.label ?? "No label"}</span>
              <span className="font-mono text-[12px] text-sym-muted">
                {formatInviteHint(invite.hint)}
              </span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}
