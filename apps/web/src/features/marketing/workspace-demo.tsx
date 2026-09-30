"use client";

import { Check, GitCommitVertical, Inbox, Lock, Moon, Plus, Search, Target, X } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";
import "@/features/workspace/workspace.css";
import { type DemoListId, demoLabels, demoLists, demoTasks, tours } from "./demo-data";

/**
 * The interactive preview under the hero: a working miniature of the workspace.
 *
 * It is a real component with real state rather than a screenshot, because the argument the page is
 * making — that this is small enough to hold in your head — is only believable if you can push on it.
 * Everything here is local: no api, no account, nothing leaves the page.
 */

const listIcon = { now: Target, later: Moon, unclassified: Inbox } as const;

/** The tours whose subject is the task document rather than the list. */
const pagePanes = new Set(["page", "history", "search"]);

interface Toast {
  readonly text: string;
  readonly undo?: () => void;
}

export function WorkspaceDemo() {
  const [tourId, setTourId] = useState(tours[0]?.id ?? "lists");
  const [list, setList] = useState<DemoListId>("now");
  const [selected, setSelected] = useState<string | null>("a");
  const [filter, setFilter] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const [done, setDone] = useState<string[]>([]);
  /*
   * Seeded from the pages themselves, so a task opens showing what it already has ticked. Ticking
   * here only moves this local set — the preview writes nothing anywhere.
   */
  const [checked, setChecked] = useState<string[]>(() =>
    demoTasks.flatMap((entry) =>
      entry.blocks
        .filter((block) => block.kind === "check" && block.checked)
        .map((block) => block.text),
    ),
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pq, setPq] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);

  const tour = tours.find((entry) => entry.id === tourId) ?? tours[0];

  /** Each tab puts the preview into the state that shows the thing it names. */
  const goTour = (id: string) => {
    setTourId(id);
    setPaletteOpen(id === "search");
    setHistoryOpen(id === "history");
    setFilter(id === "labels" ? "personal" : null);
    setPicked(null);
    setPq("");
    if (id !== "lists") setSelected("a");
    if (id === "lists") setList("now");
  };

  const rows = useMemo(() => {
    const seeded = demoTasks
      .filter((task) => task.list === list)
      .filter((task) => (filter ? task.labelId === filter : true))
      .filter((task) => !done.includes(task.id));
    const typed = list === "now" && !filter ? added : [];
    return [
      ...typed.map((title, index) => ({
        id: `added-${index}`,
        title,
        labelId: undefined,
        due: undefined,
        subs: undefined,
      })),
      ...seeded,
    ];
  }, [list, filter, added, done]);

  const task = demoTasks.find((entry) => entry.id === selected) ?? null;
  const listName = demoLists.find((entry) => entry.id === list)?.name ?? "Now";

  const show = (text: string, undo?: () => void) => {
    setToast(undo ? { text, undo } : { text });
    window.setTimeout(() => setToast(null), 4000);
  };

  const submitDraft = () => {
    const title = draft.trim();
    if (!title) return;
    setAdded((current) => [title, ...current]);
    setDraft("");
    show(`Added “${title}” to Now`);
  };

  const complete = (id: string, title: string) => {
    setDone((current) => [...current, id]);
    if (selected === id) setSelected(null);
    show(`Completed “${title}”`, () => {
      setDone((current) => current.filter((entry) => entry !== id));
      setToast(null);
    });
  };

  const paletteItems = useMemo(() => {
    const all = [
      ...demoTasks.map((entry) => ({
        label: entry.title,
        hint: "Open task",
        run: () => {
          setSelected(entry.id);
          setList(entry.list);
        },
      })),
      { label: "Go to Later", hint: "g l", run: () => setList("later") },
      { label: "Open history", hint: "g h", run: () => setHistoryOpen(true) },
      { label: "Show history", hint: "Page", run: () => setHistoryOpen(true) },
    ];
    const needle = pq.trim().toLowerCase();
    return needle
      ? all.filter((item) => item.label.toLowerCase().includes(needle))
      : all.slice(0, 5);
  }, [pq]);

  /*
   * The app's own row keys: Enter or Space opens, `x` completes. The row is the single tab stop of
   * the tree and the checkbox inside it is `tabIndex={-1}`, exactly as `task-row.tsx` has it — one
   * target per row, which is both how a tree is meant to behave and what keeps the 16px control
   * clear of WCAG's target-size rule without growing it here and nowhere else.
   */
  const onRowKey = (event: KeyboardEvent<HTMLDivElement>, id: string, title: string) => {
    if (event.target !== event.currentTarget) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelected(id);
      return;
    }
    if (event.key === "x" || event.key === "X") {
      event.preventDefault();
      complete(id, title);
    }
  };

  return (
    <section id="product" className="sym-demo-section" aria-label="Interactive product preview">
      <div role="tablist" aria-label="What to look at" className="sym-demo-tabs">
        {tours.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={entry.id === tourId}
            className="sym-demo-tab"
            data-active={entry.id === tourId || undefined}
            onClick={() => goTour(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="sym-demo-frame">
        {/*
         * On a phone the workspace shows one pane at a time, and so does this. Which pane a tour
         * wants is not a guess — three of the five are about the document, two about the list — so
         * the tab the visitor already pressed decides it, and the narrow layout reads that attribute.
         */}
        <div className="sym-demo-app" data-pane={pagePanes.has(tourId) ? "page" : "list"}>
          <div className="sym-topbar">
            <span className="sym-avatar">MR</span>
            <span className="sym-demo-name">Maya</span>
            <span className="sym-demo-vault">
              <Lock size={14} strokeWidth={1.8} aria-hidden="true" />
              Vault
            </span>
            <button
              type="button"
              /*
               * A phone drops both the label and the ⌘K hint, which left the button with nothing but
               * an icon and no accessible name at all. The name is stated here and kept inside the
               * visible text at wider widths, so it reads the same either way.
               */
              aria-label="Search or jump to"
              className="sym-demo-search"
              onClick={() => {
                setPaletteOpen(true);
                setTourId("search");
              }}
            >
              <Search size={13} strokeWidth={2} aria-hidden="true" />
              <span>Search or jump to…</span>
              <span className="sym-demo-kbd-hint">⌘K</span>
            </button>
          </div>

          <div className="sym-demo-body">
            <nav aria-label="Lists" className="sym-rail">
              {demoLists.map((entry) => {
                const Icon = listIcon[entry.id];
                const active = entry.id === list;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-label={entry.name}
                    {...(active ? { "aria-current": "page" as const } : {})}
                    className="sym-rail-item"
                    data-active={active || undefined}
                    onClick={() => setList(entry.id)}
                  >
                    <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                );
              })}
            </nav>

            <section aria-label={`${listName} tasks`} className="sym-panel sym-inbox">
              <div className="sym-panel-header">
                <h3 className="sym-panel-title">{listName}</h3>
                <span className="sym-demo-count">{rows.length}</span>
              </div>
              <div className="sym-panel-body">
                <div className="sym-inbox-content">
                  <div className="sym-inbox-tools">
                    <div className="sym-quick-add">
                      <Plus size={14} strokeWidth={2.2} aria-hidden="true" />
                      <input
                        className="sym-quick-add-input"
                        aria-label={`Add task to ${listName}`}
                        placeholder="Add task"
                        autoComplete="off"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            submitDraft();
                          }
                        }}
                      />
                      {draft.trim() ? (
                        <span aria-hidden="true" className="sym-quick-add-keys">
                          <span className="sym-kbd">↵</span>
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <fieldset className="sym-label-filter">
                    <legend className="sr-only">Filter by label</legend>
                    {demoLabels.map((label) => (
                      <button
                        key={label.id}
                        type="button"
                        aria-pressed={filter === label.id}
                        className="sym-label-filter-chip"
                        data-on={filter === label.id || undefined}
                        onClick={() => setFilter(filter === label.id ? null : label.id)}
                      >
                        <span
                          aria-hidden="true"
                          className="sym-label-dot"
                          style={{ background: `var(--sym-label-${label.colour})` }}
                        />
                        {label.name}
                      </button>
                    ))}
                  </fieldset>
                  <div role="tree" aria-label={`${listName} tasks`} className="sym-task-tree">
                    {rows.map((row) => {
                      const label = demoLabels.find((entry) => entry.id === row.labelId);
                      return (
                        <div
                          key={row.id}
                          role="treeitem"
                          aria-level={1}
                          aria-selected={row.id === selected}
                          tabIndex={row.id === selected ? 0 : -1}
                          className="sym-task-row"
                          data-selected={row.id === selected || undefined}
                          onClick={() => setSelected(row.id)}
                          onKeyDown={(event) => onRowKey(event, row.id, row.title)}
                        >
                          <input
                            type="checkbox"
                            checked={false}
                            aria-label={`Complete ${row.title}`}
                            className="sym-task-check"
                            tabIndex={-1}
                            onChange={() => complete(row.id, row.title)}
                            onClick={(event) => event.stopPropagation()}
                          />
                          <span className="sym-task-body">
                            <span className="sym-task-title">{row.title}</span>
                            <span className="sym-task-meta">
                              {label ? (
                                <span className="sym-label-chip">
                                  <span
                                    aria-hidden="true"
                                    className="sym-label-dot"
                                    style={{ background: `var(--sym-label-${label.colour})` }}
                                  />
                                  {label.name}
                                </span>
                              ) : null}
                              {row.due ? <span>{`Due ${row.due}`}</span> : null}
                              {row.subs ? <span>{row.subs}</span> : null}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                    {rows.length === 0 ? (
                      <p className="sym-inbox-note">
                        {filter ? "Nothing here carries that label." : "Nothing here yet."}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>

            <main aria-label="Task page" className="sym-page sym-demo-page">
              {task ? (
                <>
                  {/* The app's page frame: a header bar whose slot is a row, then the scrolling sheet. */}
                  <div className="sym-page-header">
                    <div className="sym-demo-header-slot">
                      <div className="sym-task-header">
                        <h3 className="sym-task-header-title">{task.title}</h3>
                        <span className="sym-task-header-meta">
                          <span role="status" className="sym-demo-saved">
                            Saved
                          </span>
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-pressed={historyOpen}
                      className="sym-task-tool sym-demo-history-toggle"
                      data-on={historyOpen || undefined}
                      onClick={() => setHistoryOpen(!historyOpen)}
                    >
                      <GitCommitVertical size={13} strokeWidth={1.9} aria-hidden="true" />
                      History
                    </button>
                  </div>
                  <div className="sym-demo-page-body">
                    <div className="sym-page-scroll">
                      <article className="sym-sheet sym-demo-doc">
                        <div className="sym-demo-doc-meta">
                          <span className="sym-task-chip">{listName}</span>
                          {task.due ? <span>{`Due ${task.due}`}</span> : null}
                        </div>
                        {task.blocks.map((block) => {
                          if (block.kind === "h") return <h4 key={block.text}>{block.text}</h4>;
                          if (block.kind === "p") return <p key={block.text}>{block.text}</p>;
                          if (block.kind === "li")
                            return (
                              <div key={block.text} className="sym-demo-li">
                                <span aria-hidden="true" className="sym-demo-bullet" />
                                <span>{block.text}</span>
                              </div>
                            );
                          const on = checked.includes(block.text);
                          return (
                            <label key={block.text} className="sym-demo-task-check">
                              {/* A real checkbox: the platform supplies the role, the state and the keying. */}
                              <input
                                type="checkbox"
                                className="sr-only"
                                checked={on}
                                onChange={() =>
                                  setChecked((current) =>
                                    on
                                      ? current.filter((entry) => entry !== block.text)
                                      : [...current, block.text],
                                  )
                                }
                              />
                              <span
                                aria-hidden="true"
                                className="sym-demo-box"
                                data-on={on || undefined}
                              >
                                {on ? <Check size={10} strokeWidth={3} /> : null}
                              </span>
                              <span data-done={on || undefined}>{block.text}</span>
                            </label>
                          );
                        })}
                      </article>
                    </div>
                    {historyOpen ? (
                      <aside aria-label="History" className="sym-demo-history">
                        <div className="sym-demo-history-head">
                          <span>History</span>
                          <span className="sym-task-chip">Git</span>
                          <button
                            type="button"
                            aria-label="Close history"
                            className="sym-icon-button"
                            onClick={() => setHistoryOpen(false)}
                          >
                            <X size={13} strokeWidth={2} aria-hidden="true" />
                          </button>
                        </div>
                        <div className="sym-demo-commits">
                          {(task?.history ?? []).map((commit) => (
                            <button
                              key={commit.hash}
                              type="button"
                              aria-pressed={picked === commit.hash}
                              className="sym-demo-commit"
                              data-on={picked === commit.hash || undefined}
                              onClick={() => setPicked(commit.hash)}
                            >
                              <span className="sym-demo-commit-msg">{commit.msg}</span>
                              <span className="sym-demo-commit-meta">
                                <code>{commit.hash}</code>
                                <span>{commit.when}</span>
                              </span>
                            </button>
                          ))}
                        </div>
                        {picked ? (
                          <div className="sym-demo-restore">
                            <p>Restoring keeps every version. It saves as a new commit.</p>
                            <button
                              type="button"
                              onClick={() => {
                                show(`Restored ${picked}. Saved as a new commit.`);
                                setPicked(null);
                              }}
                            >
                              {`Restore ${picked}`}
                            </button>
                          </div>
                        ) : null}
                      </aside>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="sym-demo-nopage">
                  <p>Pick a task to open its page</p>
                  <p>Or add one on the left.</p>
                </div>
              )}
            </main>
          </div>

          {paletteOpen ? (
            <div className="sym-demo-palette-scrim">
              {/* A real button, so dismissing works from the keyboard without a handler on a div. */}
              <button
                type="button"
                aria-label="Close the command palette"
                className="sym-demo-palette-dismiss"
                onClick={() => setPaletteOpen(false)}
              />
              <div role="dialog" aria-label="Command palette" className="sym-demo-palette">
                <div className="sym-demo-palette-input">
                  <Search size={14} strokeWidth={2} aria-hidden="true" />
                  <input
                    aria-label="Search tasks and commands"
                    placeholder="Search tasks and commands"
                    value={pq}
                    onChange={(event) => setPq(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setPaletteOpen(false);
                    }}
                  />
                  <span className="sym-kbd">esc</span>
                </div>
                <div className="sym-demo-palette-items">
                  {paletteItems.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => {
                        item.run();
                        setPaletteOpen(false);
                      }}
                    >
                      <span>{item.label}</span>
                      <span className="sym-demo-palette-hint">{item.hint}</span>
                    </button>
                  ))}
                  {paletteItems.length === 0 ? (
                    <p className="sym-inbox-note">{`Nothing matches “${pq.trim()}”.`}</p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {toast ? (
            <div role="status" className="sym-toast">
              <span>{toast.text}</span>
              {toast.undo ? (
                <button type="button" onClick={toast.undo}>
                  Undo
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <p aria-live="polite" className="sym-demo-caption">
        <span>{tour?.title}.</span> {tour?.body}
      </p>
    </section>
  );
}
