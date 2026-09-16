"use client";

import {
  type AdminAccount,
  type AdminAccountFilter,
  adminAccountFilters,
  type ListAccountsQuery,
} from "@symplist/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAccessApi } from "../../api.ts";
import { inputClassName } from "../../ui/field.tsx";
import { formatDate } from "../../ui/format.ts";
import {
  accountState,
  accountStateLabels,
  grantSourceLabels,
  onboardingLabels,
} from "../labels.ts";
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

type Filter = AdminAccountFilter | "all";

const filterLabels: Record<AdminAccountFilter, string> = {
  pending: "Pending verification",
  locked: "Locked",
  unlocked: "Unlocked",
  paused: "Paused",
};

const filterOptions: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  ...adminAccountFilters.map((filter) => ({ value: filter, label: filterLabels[filter] })),
];

/**
 * The account list (admin_accounts.md): who registered, whether they verified, their beta access,
 * where onboarding got to and how they were admitted. It never shows a person's tasks, pages, chats
 * or vault.
 */
export function AccountList() {
  const api = useAccessApi();
  const router = useRouter();
  const params = useSearchParams();
  const [filter, setFilter] = useState<Filter>((params.get("filter") as Filter | null) ?? "all");
  const [searchDraft, setSearchDraft] = useState(params.get("q") ?? "");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [more, setMore] = useState<readonly AdminAccount[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const query = useMemo<ListAccountsQuery>(
    () => ({
      ...(filter === "all" ? {} : { filter }),
      ...(search ? { q: search } : {}),
    }),
    [filter, search],
  );

  const load = useCallback(
    (signal: AbortSignal) => {
      setMore([]);
      setCursor(null);
      return api.listAccounts(query, signal);
    },
    [api, query],
  );
  const page = useResource(JSON.stringify(query), load);
  const accounts = useMemo(() => [...(page.data?.items ?? []), ...more], [page.data, more]);
  const nextCursor = cursor ?? page.data?.nextCursor ?? null;

  const updateAddress = (next: { filter?: Filter; q?: string }) => {
    const search = new URLSearchParams();
    const nextFilter = next.filter ?? filter;
    const nextQuery = (next.q ?? searchDraft).trim();
    if (nextFilter !== "all") search.set("filter", nextFilter);
    if (nextQuery) search.set("q", nextQuery);
    const text = search.toString();
    router.replace(text ? `/admin/accounts?${text}` : "/admin/accounts");
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
      const next = await api.listAccounts({ ...query, cursor: nextCursor });
      setMore((current) => [...current, ...next.items]);
      setCursor(next.nextCursor);
    } catch {
      // Keep what is on screen; the button stays for another try.
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <AdminHeader
        title="Accounts"
        description="Everyone who registered. Unlocking an account is an audited administrator grant; it never verifies someone's email."
      />

      <div className="flex flex-col gap-3">
        <FilterChips
          label="Filter accounts"
          options={filterOptions}
          value={filter}
          onChange={(value) => {
            setFilter(value);
            updateAddress({ filter: value });
          }}
        />
        <search>
          <form className="flex flex-wrap gap-2" onSubmit={submitSearch}>
            <label className="sr-only" htmlFor="account-search">
              Search accounts by email address
            </label>
            <input
              id="account-search"
              className={`${inputClassName} max-w-[320px]`}
              type="search"
              placeholder="Part of an email address"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
            />
            <Button type="submit" size="lg">
              Search
            </Button>
            {search || filter !== "all" ? (
              <Button
                variant="ghost"
                size="lg"
                onClick={() => {
                  setSearchDraft("");
                  setSearch("");
                  setFilter("all");
                  router.replace("/admin/accounts");
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </form>
        </search>
      </div>

      {page.status === "loading" ? <AdminLoading label="Loading accounts" /> : null}
      {page.status === "failed" && page.problem ? (
        <AdminFailed
          title="Couldn't load accounts"
          problem={page.problem}
          onRetry={() => page.reload()}
        />
      ) : null}
      {page.status === "ready" && accounts.length === 0 ? (
        search || filter !== "all" ? (
          <AdminEmpty
            title="No accounts match these filters"
            description="Try another state, or clear the search."
          />
        ) : (
          <AdminEmpty
            title="No accounts yet"
            description="Nobody has registered on this deployment."
          />
        )
      ) : null}

      {accounts.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Registered accounts and their beta access</caption>
          <thead>
            <tr>
              <HeadCell>Account</HeadCell>
              <HeadCell>Email</HeadCell>
              <HeadCell>Beta access</HeadCell>
              <HeadCell>Onboarding</HeadCell>
              <HeadCell>Admitted by</HeadCell>
              <HeadCell>Registered</HeadCell>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <Row key={account.id}>
                <Cell label="Account">
                  <Link
                    className="font-medium text-sym-link underline-offset-2 hover:underline"
                    href={`/admin/accounts/${account.id}`}
                  >
                    {account.displayName ?? account.email}
                  </Link>
                </Cell>
                <Cell label="Email">
                  <span className="break-all">{account.email}</span>
                  {account.emailVerifiedAt === null ? (
                    <span className="ml-2 text-[12px] text-sym-muted">Not verified</span>
                  ) : null}
                </Cell>
                <Cell label="Beta access">{accountStateLabels[accountState(account)]}</Cell>
                <Cell label="Onboarding">{onboardingLabels[account.onboardingStep]}</Cell>
                <Cell label="Admitted by">
                  {account.grantSource ? grantSourceLabels[account.grantSource] : "—"}
                </Cell>
                <Cell label="Registered">{formatDate(account.createdAt)}</Cell>
              </Row>
            ))}
          </tbody>
        </DataTable>
      ) : null}

      {nextCursor ? <LoadMore busy={loadingMore} onClick={() => void loadMore()} /> : null}
    </div>
  );
}
