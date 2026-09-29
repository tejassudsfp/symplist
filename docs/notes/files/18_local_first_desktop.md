# symplist — local-first desktop

Written September 29, 2026. This note supersedes the parts of note 07 and note 12 that place Simon
in the cloud. It is the binding decision for where the assistant runs and what the cloud is for.

## The thesis

A web assistant that cannot do work is a demo.

Simon shipped able to read a task, write a document section, and call a connector. What it could
never do was the thing people actually want from an assistant: run something. Check whether the
build passes. Grep a repository. Open a file, change three lines, and run the tests. Every one of
those needs a shell, a filesystem and a process, and a browser tab has none of them and never will.
That is not a gap in the implementation. It is the ceiling of the medium.

So the assistant spent its turns doing the only things a browser can do — paraphrasing documents and
asking the user for information the user was hoping it would go and find. It was fluent and it was
idle. The verdict from using it is short: **an agent that cannot execute is a chat window with
opinions.**

To execute, it needs a CLI. To have a CLI, it has to run on the machine. Once it runs on the
machine, almost everything else in the architecture is in the wrong place — the agent loop was on
Trigger, the model credential was in D1, the transcript was an encrypted envelope on another
continent, and each turn paid about seven seconds per database round trip for the privilege
(`CLAUDE.md`, worker lane). None of that buys anything once the agent is local. It was all overhead
in service of a constraint we no longer accept.

## What follows from it

The assistant moves to the desktop. The cloud stops being a place where work happens and becomes a
place where data lives.

This is the Obsidian arrangement, and the comparison is the design, not a slogan. Obsidian is a
local application over local files; its sync is a convenience you may switch on so the same vault
appears on another machine. Nothing about the product depends on the server existing. Symplist
takes the same shape: a local application over a local database, with a cloud you may connect to so
your workspace follows you.

**The cloud keeps:** the task list, Markdown documents and their Git history, Vault, connection
links, search, reminders, account and access. It is a workspace you can read and a place your data
is colocated.

**The cloud loses:** chat, the agent loop, model credentials, and every Trigger task that existed to
run a turn. Approvals go with them — a connector approval only ever existed to gate an action
mid-turn, and there is no turn here to gate.

**The desktop gets:** the assistant, powered by the DeepSeek Harness, with a shell and a filesystem
and the ability to finish a job.

### Consequences accepted deliberately

- **There are no cloud-only users.** The web becomes a viewer. Anyone who wants an assistant
  installs the app. With one beta user this costs nothing today; it is still a real decision.
- **Transcripts are local, permanently.** No conversation is ever stored in the cloud again. This
  removes the sharpest edge in the old design — turn content crossing a third-party platform in
  plaintext during its realtime window.
- **Model keys live on the device that makes the call.** The cloud never holds one and never returns
  one. The write-only property the API had is now a property of the architecture.
- **Connections are links, not capabilities.** The cloud records which accounts you connected. The
  desktop routes to Composio itself. No connector traffic passes through the server.

## The DeepSeek Harness

`dsh`, MIT, `github.com/deepseek-ai/deepseek-harness` — a plugin-based agent harness of roughly 230
packages on a Cordis core. It is not a model; the LLM layer is pluggable, which is why
bring-your-own-key survives the move intact and why every provider stays available.

It is integrated **over ACP** (`dsh-acp`, JSON-RPC on stdio), not embedded. The distinction matters:
ACP hands the client ownership of sessions, tools, model selection and permissions. So Symplist
keeps its own storage, its own approvals and its own tools — exposed to the harness as MCP servers,
which the incoming MCP work already built — while dsh supplies the loop, compaction and the shell.
Embedding it instead would import its session store and its approval model, and both collide with
guarantees we intend to keep.

The cost of ACP is its deliberate omissions: no plans, todos, terminal views or elicitation, and no
transcript replay or forks. Symplist renders what it needs from the semantic updates.

## The four phases

Each phase ends somewhere shippable. Nothing here requires the next phase to have started.

### Phase 1 — Strip chat from the cloud

Remove the agent from the server and leave a workspace that builds, deploys and works: task list,
connection manager, Vault, Markdown reading.

Deletes `packages/agent`, `core/src/simon`, `web/features/simon`, `api/modules/simon`,
`worker/trigger/simon`, `core/src/ai` and the BYOK contracts. Reshapes connections around a
`ConnectionContext` so the domain stops reaching into `SimonRepository` for an access predicate.
Keeps every other Trigger task: document Git, documents maintenance, search index, account purge,
reminders, connections reconcile, cleanup.

Tables are not dropped. Migrations are expand-only, so `conversations`, `runs`, `approvals`,
`chat_transcript_*` and `ai_provider_keys` stay and stop being written.

**Done when:** lint, typecheck, tests, both builds and e2e are green, and the deployed web app has
no chat.

### Phase 2 — The desktop shell

An Electron application carrying the existing frontend, with `dsh` as a child process over ACP and
Symplist's documents, tasks and Vault exposed to it as MCP tools.

Electron rather than Tauri for one specific reason: dsh is a Node application, and Electron already
embeds Node. Tauri would be a far smaller binary and then require shipping and versioning a Node
runtime anyway, purely to host the harness.

macOS first, Windows after. Unsigned builds for testing before any notarization work.

**Done when:** the app installs, connects to the cloud account, and Simon completes a turn that runs
a command and edits a document.

### Phase 3 — Local mode

The same application with no cloud at all: local SQLite through the existing `DATA_DRIVER=local`
path, an in-process scheduler in place of Trigger, and every key supplied by the user.

The twelve generated secret families are generated on first run — `CONTENT_KEK`,
`VAULT_RECOVERY_KEY`, the digest secrets, the signing keys. Only a model provider key and,
optionally, a Composio key are ever typed. `CONTENT_KEK` goes to the macOS Keychain or the Windows
Credential Manager, with a one-time instruction to back the recovery key up, because offline there
is no operator to recover anything.

Local mode has no D1 budget lane, so it has none of the per-request cost that made cloud turns slow.

**Done when:** a fresh install with no account can create tasks, write documents and run Simon.

### Phase 4 — Promotion

Moving from local to cloud, once, without losing anything.

The desktop walks its local database and pushes batches; a Trigger task performs cloud-side
ingestion, indexing and verification. It cannot be the other way around — a Trigger task cannot read
the user's disk. Data is decrypted locally and **re-encrypted under the cloud account data key before
it leaves the machine**; plaintext exists only in memory on the user's own computer.

The user sees progress and is told not to close the window, which is honest, because the app is
driving.

Transcripts do not migrate. They are local and they stay local. After promotion, Markdown is fetched
from the cloud only.

**Done when:** a local install with real data connects, redeems a beta code, and arrives in the cloud
complete and readable.

## Open questions

- Whether the existing cloud chat data is exported to the desktop on first connect, or dropped. One
  beta user, so the cost of dropping is known and small.
- Whether approval mode stays a stored per-connection field once approvals are a desktop concern.
- Whether reminders remain the only reason the cloud runs scheduled work, and whether that is worth
  a Trigger dependency on its own.
