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
 * A key is write-only, here and everywhere else. The field is emptied the moment it is accepted,
 * the api has no route that returns one, and the response type has no field a key could occupy. The
 * screen's whole vocabulary is "configured", "working", and two dates. Anyone who needs to see a
 * key again reads it from their provider's dashboard, which should be the only place that still
 * has it.
 *
 * "Working" appears only once a provider has accepted the key on a real call, because that is the
 * only thing that proves it: a well-formed key and a live key look identical from here.
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

/** The dropdown entry that swaps the model list for a free-text field. */
const CUSTOM = "__custom__";

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const fieldClass =
  "min-h-[34px] rounded-[var(--sym-r)] border border-[var(--sym-line-strong)] bg-transparent px-[9px] py-[6px] text-[13.5px]";

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
        if (mounted.current) setFailure("Check your connection and try again.");
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
        if (mounted.current) setFailure("Check the key and try again.");
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
    <div className="flex flex-col gap-7" data-slot="ai-settings">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 font-heading font-semibold text-[20px] tracking-[-0.01em]">Models</h1>
        <p className="m-0 max-w-[520px] text-[13.5px] text-sym-muted">
          Simon runs on your own provider account, so nothing here is charged to Symplist. A key is
          encrypted before it is stored and is never shown again — not even to you.
        </p>
      </header>

      {settings.usable ? null : (
        <Notice tone="warning">
          Simon needs a key before it can answer. Add one for OpenAI or Anthropic to get started.
        </Notice>
      )}
      {failure ? <InlineError title="That didn't save" description={failure} /> : null}

      <section aria-labelledby="ai-keys-title" className="flex flex-col gap-3">
        <h2 id="ai-keys-title" className="m-0 font-heading font-semibold text-[15px]">
          Provider keys
        </h2>
        <div className="flex max-w-[520px] flex-col gap-3">
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
              onDraft={(value) =>
                setDrafts((current) => ({ ...current, [status.provider]: value }))
              }
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
      </section>

      <section aria-labelledby="ai-tiers-title" className="flex flex-col gap-3">
        <h2 id="ai-tiers-title" className="m-0 font-heading font-semibold text-[15px]">
          What answers each tier
        </h2>
        <p className="m-0 max-w-[520px] text-[13.5px] text-sym-muted">
          The two tiers are independent — Fast and Smart can come from different providers.
        </p>
        <div className="flex max-w-[520px] flex-col gap-3">
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
    </div>
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
  const status = !configured
    ? "Not configured"
    : verifiedAt !== null
      ? `Working · confirmed ${formatDate(verifiedAt)}`
      : `Saved${createdAt === null ? "" : ` ${formatDate(createdAt)}`} · not used yet`;

  return (
    <article
      className="flex flex-col gap-3 rounded-[var(--sym-r)] border border-[var(--sym-line)] p-4"
      data-slot="provider-key"
      data-provider={provider}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="m-0 font-heading font-semibold text-[13.5px]">{providerLabels[provider]}</h3>
        <p className="m-0 text-[12.5px] text-sym-muted">{status}</p>
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
          <span role="status" className="text-[12.5px] text-sym-muted">
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
  const customId = useId();

  // A model outside the suggested list stays reachable — providers ship faster than we deploy — but
  // through a Custom entry in the dropdown rather than a free-text box nobody asked for.
  //
  // Derived, not synced: `suggestions` is rebuilt by the parent on every render, so an effect
  // keyed on it would fire constantly and slam the field shut the moment Custom was picked.
  const [customChosen, setCustomChosen] = useState(false);
  const custom = customChosen || !suggestions.includes(model);
  const [draft, setDraft] = useState(model);

  useEffect(() => setDraft(model), [model]);

  const commitCustom = () => {
    const next = draft.trim();
    if (next.length > 0 && next !== model) onChange(provider, next);
  };

  return (
    <article
      className="flex flex-col gap-3 rounded-[var(--sym-r)] border border-[var(--sym-line)] p-4"
      data-slot="tier-choice"
      data-tier={tier}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="m-0 font-heading font-semibold text-[13.5px]">{tierLabels[tier]}</h3>
        <p className="m-0 text-[12.5px] text-sym-muted">{tierHints[tier]}</p>
      </header>

      {ready ? null : (
        <p className="m-0 text-[12.5px] text-sym-muted" role="status">
          This tier needs an {providerLabels[provider]} key before it can run.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-[12.5px]" htmlFor={providerId}>
          Provider
          <select
            id={providerId}
            className={fieldClass}
            value={provider}
            disabled={busy}
            onChange={(event) => onChange(event.target.value as AiProvider, model)}
          >
            {(Object.keys(providerLabels) as AiProvider[]).map((value) => (
              <option key={value} value={value}>
                {providerLabels[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1.5 text-[12.5px]" htmlFor={modelId}>
          Model
          <select
            id={modelId}
            className={fieldClass}
            value={custom ? CUSTOM : model}
            disabled={busy}
            onChange={(event) => {
              if (event.target.value === CUSTOM) {
                setCustomChosen(true);
                return;
              }
              setCustomChosen(false);
              onChange(provider, event.target.value);
            }}
          >
            {suggestions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
            <option value={CUSTOM}>Custom model…</option>
          </select>
        </label>
      </div>

      {custom ? (
        <div className="grid max-w-[320px] gap-1.5 text-[12.5px]">
          {/* The hint is described-by rather than inside the label: a label wrapping both would
              make the field's accessible name the whole paragraph. */}
          <label htmlFor={customId}>Model id</label>
          <input
            id={customId}
            className={fieldClass}
            value={draft}
            disabled={busy}
            spellCheck={false}
            placeholder="gpt-5.6-luna"
            aria-describedby={`${customId}-hint`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitCustom}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitCustom();
              }
            }}
          />
          <p id={`${customId}-hint`} className="m-0 text-sym-muted">
            Anything your provider accepts. Nothing is checked until Simon runs.
          </p>
        </div>
      ) : null}
    </article>
  );
}
