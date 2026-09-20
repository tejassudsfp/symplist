# Usage-limit checkpoint — 2026-09-16

The owner requested immediate snapshots and then explicitly authorized branch pushes. This is an incomplete-work checkpoint, not D2/E sign-off. No main push, force push or PR.

## Root: feat/symplist-build

Parent `ee05885` includes native task expiry/replay fixes (`0bb80ba`), Sharing actor freshness (`0b16f00`), atomic quick save and guarded close/expiry. Root's checkpoint adds Simon chat presentation adapted from Vercel AI Elements, with its Apache license/notice and exact `use-stick-to-bottom` dependency. It retains Symplist transport and approval controls; no Trigger Sessions, AI SDK approval flow or default Vercel chat endpoint.

Implemented UI: owner-scoped reopenable stores, drafts, exact-key uncertain submission retry, bounded live projection/replay, safe Markdown, task chat, task-less quick chat, close/save controls, Fast/Smart selection, Stop/retry, approval editing, question replies, activity presentation and terminal-run status. Contracts/core history expose an allowlisted latest-run outcome. Last addition is earlier-history pagination; it has typechecked but needs its own race/replay tests.

Verification at pause:

- All 17 projects typecheck on the latest source.
- Lint passed over 1,302 files before the last pagination addition; the latest changed Simon files were formatted with Biome.
- 25 Simon projection/store/component tests passed before pagination. Includes actual Strict Mode provider remount, safe Markdown, Enter/IME no-send, quick close/focus, uncertain retries and unavailable-provider presentation.
- Full `pnpm test` FAILED. Web: 1,581 passed, two layout failures. One is missing `window.matchMedia` in the layout test environment causing Conversation to throw; the other still expects the now-built quick-chat slot to be empty. Update genuine pre-D2 expectations explicitly in the eventual commit and supply a proper media-query test environment (do not suppress assertions).
- Core reported timeouts in Vault daily-budget and document service/tools tests during the concurrent full run. Rerun unchanged focused tests before attributing these to contention. The aggregate run exited after web failure; no full-green claim.
- Builds, browser gates, live suites and final docs/deploy checks have not run for this UI checkpoint.

## Worktree inventory and merge order

All trees live under `/Users/tejassuds/projects/symplist-wt/`. Do not touch the owner's separate `symplist-run` checkout or its 3000/4000 servers.

| Branch | State at checkpoint request | Next action |
| --- | --- | --- |
| `wip/d2-connections` | Clean, pushed `ed5abf3`; agent stopped | Read final branch report; merge backend first, typecheck and account for every changed path |
| `wip/d2-maintenance` | Clean, pushed `e61264b`; agent stopped | Read `simon-sharing-checkpoint.md` on branch; snapshot is explicitly unfinished until tests/review pass |
| `wip/d2-connections-ui` | Clean `5341297` | Merge after Connections backend; preserve both CSS blocks and root shell/UI changes |
| `wip/e-visual` | Clean `77f73af`, merged at `92d4cbd` | 36 populated-workspace frames inspected; two contrast fixes. Merge typecheck/lint/docs pass |
| `wip/e-d1-load` | Clean `fb6783b` | Work already integrated; retain branch backup |
| `wip/d2-scheduling` | Clean `1792f5f` | Already integrated; retain branch backup |
| `wip/d2-sharing` | Clean `e2b61f0` | Already integrated; retain branch backup |
| `wip/d2-vault` | Clean `f881976` | Already integrated; retain branch backup |

Agent commits may advance these listed parents. Use `git worktree list`, each branch report and actual remote hashes on resume. Do not infer completion from an agent being idle.

Root UI snapshot is `236349f`, pushed to `origin/feat/symplist-build`. Completed scheduling, sharing, Vault and load branches are also backed up on origin. Connections UI/visual backup was handled centrally after its agent was interrupted by the pause request. No feature work continues during this pause.

Maintenance's exact first resume defect: its draft regression imports `DurableDocumentGit` from nonexistent `documents/durable.ts`; the actual module is `git-jobs.ts`. Production wiring typechecked before that test was added. Fix the import, then finish parity/event/revoke-race tests and full gates; do not merge it as verified. Connections reports focused MCP tests green but still requires its final Git-history timeout rerun and overall review/gate refresh.

## Remaining integration work

- Simon: real Composio wrapper factory and approved-effect wiring, edited-argument validator, narrow Vault-handle schema/resolution/redaction; shared native Sharing/handoff adapters; context compaction/epochs; actual unavailable-provider outcome propagation (maintenance was asked to preserve stable codes if feasible).
- Connections worker hourly hooks: `cleanupMcp({db, now, mode: 'durable', generation})` and `connectionReconcilerFor(runtime)?.drain({mode: 'durable', generation})`, fenced like existing cleanup. Local hooks are on Connections branch.
- UI: history pagination race tests; approval edit/expiry and real keyboard-dispatch/remapping tests; document outline-request seam; meaningful section labels/links in activity; actual task/quick-chat browser journeys and visuals. Quick close recovers a lost create response with its original creation key; test programmatic navigation/unmount while quick chat is open. Review retained drafts/maps and denied/replayed responses.
- Review close/expiry against an already subscribed topic and cached run-output relay status; database late checkpoints already refuse deleted conversations, but ring/cache behavior needs explicit testing.
- Quick-chat-started and remaining native/reminder analytics hooks need review.
- Native task replay merge `0bb80ba` still needs final per-file loss audit in root; typecheck passed after merge.
- Phase E: all 20 cross-feature flows, broader executor parity/restart/mode-change cases, new-screen visual coverage (the 36 ready frames cover populated workspace lists, not all Simon/new screens), live D1/R2/Trigger/OpenAI/Composio/PostHog suites.
- Root `.env.local` has NOT been read/distributed during this work; live migrations have NOT been applied. Follow CLAUDE secret-placement matrix, preserve identical 12 API/worker key families, never print values. Check actual migration count after merging Connections.
- Rerun the complete definition-of-done gates. Clean web build removes package outputs; rebuild them before local smoke if necessary. Browser gates use 3300/4300, not the owner's runtime ports. No tests were weakened or skipped for this checkpoint.
