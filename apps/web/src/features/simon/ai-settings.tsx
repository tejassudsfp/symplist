"use client";

import type { AiProvider, AiSettings, AiTier } from "@symplist/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { TextField } from "@/features/access/ui/field";
import { Notice } from "@/features/access/ui/notice";
import { type AiSettingsApi, createAiSettingsApi } from "./ai-settings-api.ts";

/**
 * Settings → Models (§8.6): the account's own provider keys, and which model answers each tier.
 *
 * Simon runs on the account's credential, so this screen is the one thing standing between a new
 * account and a working assistant. It says that plainly at the top when nothing is configured
 * rather than leaving someone to discover it when a message fails.
 *
 * A key is write-only here, as it is everywhere else: the field is emptied the moment it is saved,
 * and what comes back is "configured on 3 October", never the value. Anyone who needs to see a key
 * again reads it from their provider dashboard, which is the only place that should still have it.
 */

const providerLabels: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

const providerHints: Record<AiProvider, string> = {
  openai: "Starts with sk-. Create one at platform.openai.com.",
  anthropic: "Starts with sk-ant-. Create one at console.anthropic.com.",
};

const tierLabels: Record<AiTier, string> = {
  fast: "Fast",
  smart: "Smart",
};

const tierHints: Record<AiTier, string> = {
  fast: "Everyday replies and small actions.",
  smart: "Harder thinking, when you ask for it.",
};

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function AiSettingsScreen({ api = createAiSettingsApi() }: { api?: AiSettingsApi }) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<AiProvider, string>>>({});
  const [saved, setSaved] = useState<AiProvider | null>(null);
  const mounted = useRef(true);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        setSettings(await api.settings(signal));
        setFailure(null);
      } catch {
        if (mounted.current) setFailure("Your model settings could not be loaded.");
      }
    },
    [api],
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [load]);

  const run = useCallback(
    async (label: string, action: (signal: AbortSignal) => Promise<AiSettings | null>) => {
      setBusy(label);
      setFailure(null);
      const controller = new AbortController();
      try {
        const next = await action(controller.signal);
        if (!mounted.current) return;
        if (next) setSettings(next);
        else await load(controller.signal);
      } catch {
        if (mounted.current) setFailure("That didn't save. Check the key and try again.");
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [load],
  );

  const saveKey = (provider: AiProvider) => {
    const key = (drafts[provider] ?? "").trim();
    if (key.length === 0) return;
    void run(`key:${provider}`, async (signal) => {
      await api.setKey(provider, key, signal);
      // Out of component state the instant it is accepted: a key has no business sitting in a
      // React tree, a re-render or a devtools snapshot after it has been stored.
      setDrafts((current) => ({ ...current, [provider]: "" }));
      setSaved(provider);
      return null;
    });
  };

  if (failure && !settings) {
    return (
      <InlineError
        title="Couldn't load your model settings"
        description={failure}
        onRetry={() => load(new AbortController().signal)}
      />
    );
  }
  if (!settings) return <p role="status">Loading your model settings…</p>;

  return (
    <section className="flex flex-col gap-6" data-slot="ai-settings">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-medium">Models</h1>
        <p className="text-sm text-[var(--sym-muted)]">
          Simon runs on your own provider account. Add a key below and it is encrypted before it is
          stored; it is never shown again, and nothing here is charged to Symplist.
        </p>
      </header>

      {!settings.usable ? (
        <Notice tone="warning">
          Simon needs a key before it can answer. Add one for OpenAI or Anthropic to get started.
        </Notice>
      ) : null}
      {failure ? <InlineError title="That didn't save" description={failure} /> : null}

      <div className="flex flex-col gap-4">
        {settings.keys.map((status) => (
          <ProviderKey
            key={status.provider}
            provider={status.provider}
            configured={status.configured}
            createdAt={status.createdAt}
            verifiedAt={status.verifiedAt}
            draft={drafts[status.provider] ?? ""}
            saved={saved === status.provider}
            busy={busy === `key:${status.provider}`}
            onDraft={(value) => setDrafts((current) => ({ ...current, [status.provider]: value }))}
            onSave={() => saveKey(status.provider)}
            onClear={() =>
              void run(`key:${status.provider}`, async (signal) => {
                await api.clearKey(status.provider, signal);
                setSaved(null);
                return null;
              })
            }
          />
        ))}
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-base font-medium">What answers each tier</h2>
        {settings.tiers.map((tier) => (
          <TierChoice
            key={tier.tier}
            tier={tier.tier}
            provider={tier.provider}
            model={tier.model}
            ready={tier.ready}
            busy={busy === `tier:${tier.tier}`}
            suggestions={
              settings.suggestions.find((entry) => entry.provider === tier.provider)?.models ?? []
            }
            onChange={(provider, model) =>
              void run(`tier:${tier.tier}`, (signal) =>
                api.setModels({ [tier.tier]: { provider, model } }, signal),
              )
            }
          />
        ))}
      </div>
    </section>
  );
}

function ProviderKey({
  provider,
  configured,
  createdAt,
  verifiedAt,
  draft,
  saved,
  busy,
  onDraft,
  onSave,
  onClear,
}: {
  provider: AiProvider;
  configured: boolean;
  createdAt: number | null;
  verifiedAt: number | null;
  draft: string;
  saved: boolean;
  busy: boolean;
  onDraft: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const fieldId = useId();
  return (
    <article
      className="flex flex-col gap-3 rounded-[var(--sym-radius-md,8px)] border border-[var(--sym-border)] p-4"
      data-slot="provider-key"
      data-provider={provider}
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{providerLabels[provider]}</h3>
        <p className="text-xs text-[var(--sym-muted)]">
          {configured
            ? verifiedAt !== null
              ? `Working · last used ${formatDate(verifiedAt)}`
              : `Saved${createdAt === null ? "" : ` ${formatDate(createdAt)}`} · not used yet`
            : "Not configured"}
        </p>
      </header>

      <TextField
        id={fieldId}
        label={configured ? "Replace this key" : "API key"}
        // `password` so a shoulder, a shared screen or a screenshot does not carry it.
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        description={providerHints[provider]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || draft.trim().length === 0} onClick={onSave}>
          {configured ? "Replace key" : "Save key"}
        </Button>
        {configured ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClear}>
            Remove
          </Button>
        ) : null}
        {saved ? (
          <span role="status" className="text-xs text-[var(--sym-muted)]">
            Saved. It will not be shown again.
          </span>
        ) : null}
      </div>
    </article>
  );
}

function TierChoice({
  tier,
  provider,
  model,
  ready,
  busy,
  suggestions,
  onChange,
}: {
  tier: AiTier;
  provider: AiProvider;
  model: string;
  ready: boolean;
  busy: boolean;
  suggestions: readonly string[];
  onChange: (provider: AiProvider, model: string) => void;
}) {
  const providerId = useId();
  const modelId = useId();
  const listId = `${modelId}-options`;
  const [draft, setDraft] = useState(model);
  useEffect(() => setDraft(model), [model]);

  return (
    <article
      className="flex flex-col gap-3 rounded-[var(--sym-radius-md,8px)] border border-[var(--sym-border)] p-4"
      data-slot="tier-choice"
      data-tier={tier}
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{tierLabels[tier]}</h3>
        <p className="text-xs text-[var(--sym-muted)]">{tierHints[tier]}</p>
      </header>

      {!ready ? (
        <p className="text-xs text-[var(--sym-muted)]" role="status">
          This tier needs an {providerLabels[provider]} key before it can run.
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs" htmlFor={providerId}>
          Provider
          <select
            id={providerId}
            className="rounded-[var(--sym-radius-sm,6px)] border border-[var(--sym-border)] px-2 py-1 text-sm"
            value={provider}
            disabled={busy}
            onChange={(event) => onChange(event.target.value as AiProvider, draft)}
          >
            {(Object.keys(providerLabels) as AiProvider[]).map((value) => (
              <option key={value} value={value}>
                {providerLabels[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs" htmlFor={modelId}>
          Model
          {/* A list, not a closed set: a provider ships models faster than we deploy, so a typed id
              is accepted and the run reports whatever the provider says about it. */}
          <input
            id={modelId}
            list={listId}
            className="rounded-[var(--sym-radius-sm,6px)] border border-[var(--sym-border)] px-2 py-1 text-sm"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => draft !== model && draft.trim().length > 0 && onChange(provider, draft)}
          />
          <datalist id={listId}>
            {suggestions.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
      </div>
    </article>
  );
}
