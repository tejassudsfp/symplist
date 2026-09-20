# Working on Symplist with agents

Conventions for multi-agent work on this repo. Read `CLAUDE.md` first for project status, stack and
hard rules — this file covers only how to run agents without losing work.

Everything below was learned by losing work to it.

---

## Current state, in one paragraph

Phase D1 is merged onto `feat/symplist-build` (four merge commits, all `wip/*` branches fully
absorbed) but **the merged tree has never passed a full gate run** — a session crash killed the
merge agent during its final verification. 93 files sit uncommitted: 79 regenerated e2e evidence
screenshots, 12 real cross-feature fixes, one new helper. The next job is gates → fix → commit →
prove nothing was lost, then D2. Full detail in `CLAUDE.md`.

---

## The five rules

### 1. One writer per worktree. Always.

Feature work happens in git worktrees under `../symplist-wt/<feature>`. **Exactly one agent may
write to a worktree at a time.** Two writers in one worktree has cost this project three separate
stages.

### 2. `ListAgents` cannot see agents inside a Workflow

This is the trap. An empty `ListAgents` listing is **not** proof a workflow released its worktrees.
A workflow that looked finished was still building in three worktrees; a second wave launched on
that false signal and put two writers in each.

Check the transcripts instead:

```bash
D=~/.claude/projects/<project>/<session>/subagents/workflows/<runId>
for f in $D/agent-*.jsonl; do
  echo "$(stat -f '%Sm' -t '%H:%M:%S' $f)  $(basename $f .jsonl)"
  grep -o 'symplist-wt/[a-z]*' $f | sort | uniq -c | sort -rn | head -1   # which worktree it holds
done
```

A recent mtime means it is alive. The `journal.jsonl` in the same directory records one
`{"type":"result"}` line per finished agent.

### 3. Never tell an agent to stand down if it suspects a duplicate

When two agents share a worktree the evidence looks identical from both sides, so **both** stand
down and nothing gets committed. That cost a finished 26-minute build plus its review. One agent
even misread its own `biome check --write` pass as an outside writer.

Assert ownership positively in the prompt instead:

> You are the only agent in this worktree. Do not check for others. Do not stand down.

### 4. Every prompt carries an autonomy rule

An agent that pauses to ask a question stalls forever — there is nobody reading. Include verbatim:

> You are running unattended. There is NOBODY to ask, and a question ends your run without finishing
> the work. When something is ambiguous, pick the option most consistent with the architecture and
> the brief, implement it, and record the choice in your report under "Decisions".

And give prompts **complete** context — no truncated notes. Every stall traced back to an agent
needing something it was not given.

### 5. Do not `SendMessage` a running Workflow agent

The reply resumes a *second* copy under the same agent id while the original keeps running — two
writers again. If an agent must be corrected mid-run, let its review stage reconcile.

The one exception: an agent that has explicitly stopped and asked a question is already blocked, so
answering it is the only way forward. Answer decisively and completely.

---

## Workflow shape that works

Per feature: **finish** stage → **adversarial review** stage, run as a `pipeline()` so each feature
moves independently rather than waiting on a barrier. The review reads the whole branch diff, fixes
every real defect itself, and returns a `ready-to-merge` / `not-ready` verdict.

This has been worth it. The reviews caught, among others: a task tree with **no tab stop at all**
(the entire list unreachable by keyboard); a parent-complete path that silently archived every
subtask; a statement binding 101 parameters against D1's 100 limit; an unpruned detail map that
fired ~60 concurrent reads at a 2 req/s lane after a reconnect.

**Definition of done for any stage** — all four, from the worktree root:

```bash
pnpm lint        # zero errors AND zero warnings
pnpm typecheck
pnpm test
pnpm --filter @symplist/web build
```

Reports should be structured (use the `schema` option) and truthful: a check that did not pass is
reported as not passing.

---

## Merging feature branches

Merge **one branch at a time** with `--no-ff`, running `pnpm install` (if manifests changed) and
`pnpm typecheck` between each. Resolving four branches at once is how work gets silently dropped.

Known hotspots, every time:

- `apps/web/src/components/shell/workspace.tsx` — several features extend the same seam.
- `apps/web/src/app/globals.css` — every feature appends; keep all contributions.
- `pnpm-lock.yaml` — take every importer's entries, then `pnpm install`.
- `docs/build/decisions.md` — `merge=union`; keep every row.
- Migration numbering — no gaps, no duplicates, still expand-only.

**Budget for the integration tail.** On the D1 merge the merges themselves took ~15 minutes; the
following ~70 were cross-feature failures — specs written in a worktree where the other feature did
not exist, now running against each other for the first time. That took 14 `pnpm e2e` runs and 19
source edits. It is the point of merging, but plan for it.

After a merge, always prove nothing was lost:

```bash
git diff feat/symplist-build...wip/<branch> --stat   # for each branch; account for every line
```

Conflict resolutions that silently took one side are the usual cause of a vanished feature.

---

## Other things that will bite

- **Session rate limits kill every agent at once.** When it happens, snapshot each worktree into an
  explicit WIP commit immediately, marked unverified, so nothing depends on a process staying alive.
- **Don't write into the repo while an agent holds it.** Stage work in the scratchpad and land it
  after. An agent running `git add` will otherwise sweep your files into its commit.
- **`pnpm e2e` is the expensive gate** — it cold-starts a Next server and an api server, then runs
  Playwright across three viewports. Expect minutes per run, and don't run two at once.
- **No SVG rasterizer is installed on this machine.** Use the repo's own `playwright-core` via
  `require()` from `node_modules/.pnpm/playwright-core@*/node_modules/playwright-core`.
