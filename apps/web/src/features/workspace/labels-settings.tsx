"use client";

import type { LabelColour, LabelView } from "@symplist/contracts";
import {
  LABEL_MAX_PER_OWNER,
  LABEL_NAME_MAX_LENGTH,
  normalizeLabelName,
} from "@symplist/contracts";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { SkeletonLines } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { accentPresetIds, accentPresets } from "@/theme/accent";
import { classifyFailure, loadFailureCopy, writeFailureMessage } from "./errors.ts";
import { labelColorVariable } from "./labels.tsx";
import { useTaskCollection, useWorkspace } from "./workspace-provider.tsx";

/**
 * What to say when a label write is refused, in the words the person can act on.
 *
 * `label.duplicate_name` and `label.limit_reached` are the two refusals a form can actually fix, so they
 * are named rather than folded into the generic "check what you entered": the first says which name is
 * taken and the second says what the cap is.
 */
function labelWriteMessage(error: unknown, attempt: string): string {
  if (error instanceof ApiError) {
    if (error.code === "label.duplicate_name") return "You already have a label with that name.";
    if (error.code === "label.limit_reached") {
      return `You can have ${LABEL_MAX_PER_OWNER} labels. Delete one to add another.`;
    }
  }
  return writeFailureMessage(classifyFailure(error), attempt);
}

/**
 * The eight colours as real radio buttons, each hidden behind its swatch.
 *
 * Real inputs rather than `role="radio"` on a button: arrow-key navigation, the grouping and the
 * announced name all come from the platform, and the swatch is only paint. `name` is per form, so an
 * open edit row and the New label form below it do not share one group.
 */
function ColourChoice({
  name,
  value,
  onChange,
  labelledBy,
}: {
  readonly name: string;
  readonly value: LabelColour;
  readonly onChange: (colour: LabelColour) => void;
  readonly labelledBy: string;
}) {
  return (
    <div className="sym-label-swatches" role="radiogroup" aria-labelledby={labelledBy}>
      {accentPresetIds.map((colour) => (
        <label
          key={colour}
          className="sym-label-swatch"
          style={{ background: labelColorVariable(colour) }}
        >
          <input
            type="radio"
            className="sr-only"
            name={name}
            value={colour}
            checked={value === colour}
            onChange={() => onChange(colour)}
          />
          <span className="sr-only">{accentPresets[colour].label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * Settings → Labels: the account's labels, with the words and colours in one place.
 *
 * Labels are made and renamed here rather than from a task row, because a label is a word reused across
 * the whole list — typing one wherever it is needed is how a list ends up with "Work", "work" and
 * "wrok". A row shows how many active tasks carry each one, so a label nobody is using is visible as
 * such before it is deleted.
 *
 * There is no separate fetch: labels ride in the task tree response, so opening this page shows what the
 * workspace already loaded.
 */
export function LabelsSettings() {
  const { tasks, commands } = useWorkspace();
  const snapshot = useTaskCollection("now");
  const [editing, setEditing] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (snapshot.status === "loading" || snapshot.status === "idle") {
    return (
      <div className="sym-settings">
        <h1 className="sym-settings-title">Labels</h1>
        <SkeletonLines label="Loading your labels" />
      </div>
    );
  }

  if (snapshot.status === "error" && snapshot.failure) {
    return (
      <div className="sym-settings">
        <h1 className="sym-settings-title">Labels</h1>
        <InlineError
          {...loadFailureCopy(snapshot.failure, "your labels")}
          onRetry={() => void tasks.refresh("now")}
        />
      </div>
    );
  }

  const labels = snapshot.labels;

  return (
    <div className="sym-settings">
      <h1 className="sym-settings-title">Labels</h1>
      <p className="sym-settings-intro">
        A label is your own word for a slice of your list. Put one on a task from its menu, then
        filter a list by it. Names are encrypted like your task titles; the colour is not.
      </p>

      {failure ? (
        <p role="alert" className="sym-settings-note">
          {failure}
        </p>
      ) : null}

      {labels.length === 0 ? (
        <p className="sym-settings-hint">No labels yet. Make your first one below.</p>
      ) : (
        <ul className="sym-label-rows">
          {labels.map((label) =>
            editing === label.id ? (
              <li key={label.id}>
                <LabelForm
                  label={label}
                  submitLabel="Save"
                  onCancel={() => setEditing(null)}
                  onSubmit={async (name, colour) => {
                    setFailure(null);
                    try {
                      await tasks.updateLabel(label.id, { name, colour });
                      setEditing(null);
                    } catch (error) {
                      setFailure(labelWriteMessage(error, `rename “${label.name}”`));
                    }
                  }}
                />
              </li>
            ) : (
              <li key={label.id} className="sym-label-row">
                <span
                  aria-hidden="true"
                  className="sym-label-dot"
                  style={{ background: labelColorVariable(label.colour) }}
                />
                <span className="sym-label-row-name">{label.name}</span>
                <span className="sym-label-row-count">
                  {label.taskCount === 1 ? "1 task" : `${label.taskCount} tasks`}
                </span>
                <span className="sym-label-row-tools">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${label.name}`}
                    onClick={() => {
                      setFailure(null);
                      setEditing(label.id);
                    }}
                  >
                    <Pencil size={13} strokeWidth={2} aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${label.name}`}
                    onClick={() => {
                      setFailure(null);
                      void commands.deleteLabel(label.id, label.name, label.colour);
                    }}
                  >
                    <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                  </Button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}

      {/*
       * One form at a time. While a row is being edited the New label form is away, so the page never
       * shows two fields called Name with two Save buttons and leaves the person to work out which
       * one they are typing into.
       */}
      {editing !== null ? null : labels.length >= LABEL_MAX_PER_OWNER ? (
        <p className="sym-settings-hint">
          {`You have all ${LABEL_MAX_PER_OWNER} labels. Delete one to add another.`}
        </p>
      ) : (
        <section className="sym-settings-section">
          <h2 className="sym-settings-heading">New label</h2>
          <LabelForm
            submitLabel="Add label"
            onSubmit={async (name, colour) => {
              setFailure(null);
              try {
                await tasks.createLabel({ name, colour });
              } catch (error) {
                setFailure(labelWriteMessage(error, `add “${name}”`));
                throw error;
              }
            }}
          />
        </section>
      )}
    </div>
  );
}

/**
 * The name and colour of one label, for a new one or an edit.
 *
 * `onSubmit` throwing keeps the typed name in the field, so a refused create is one correction away
 * rather than a retype.
 */
function LabelForm({
  label,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  readonly label?: LabelView;
  readonly submitLabel: string;
  readonly onSubmit: (name: string, colour: LabelColour) => Promise<void>;
  readonly onCancel?: () => void;
}) {
  const [name, setName] = useState(label?.name ?? "");
  const [colour, setColour] = useState<LabelColour>(label?.colour ?? "blue");
  const [saving, setSaving] = useState(false);
  const nameId = useId();
  const colourId = useId();
  const normalized = normalizeLabelName(name);
  const unchanged = label !== undefined && normalized === label.name && colour === label.colour;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (normalized.length === 0 || saving || unchanged) return;
    setSaving(true);
    try {
      await onSubmit(normalized, colour);
      if (!label) setName("");
    } catch {
      // The message is shown by the page; the typed name stays here.
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="sym-label-form"
      aria-label={label ? `Edit ${label.name}` : "New label"}
      onSubmit={submit}
    >
      <div className="sym-label-name-field">
        <label className="sym-field-label" htmlFor={nameId}>
          Name
        </label>
        <input
          id={nameId}
          className="sym-search-input"
          value={name}
          maxLength={LABEL_NAME_MAX_LENGTH}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div>
        <span className="sym-field-label" id={colourId}>
          Colour
        </span>
        <ColourChoice
          name={`sym-label-colour-${colourId}`}
          value={colour}
          onChange={setColour}
          labelledBy={colourId}
        />
      </div>
      <Button
        type="submit"
        variant="primary"
        size="md"
        disabled={normalized.length === 0 || saving || unchanged}
      >
        <Check size={13} strokeWidth={2.4} aria-hidden="true" />
        {submitLabel}
      </Button>
      {onCancel ? (
        <Button variant="ghost" size="md" onClick={onCancel}>
          <X size={13} strokeWidth={2.2} aria-hidden="true" />
          Cancel
        </Button>
      ) : null}
    </form>
  );
}
