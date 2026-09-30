# symplist — the assistant is not ours

Written September 29, 2026; revised September 30 after building phase 2 and reading what it cost.
This note supersedes the parts of note 07 and note 12 that place Simon in the cloud, and it replaces
its own first version, which put an agent in the desktop app. It is the binding decision for where
the assistant runs and what the cloud is for.

> **Local mode was dropped (1 October 2026).** Everything below about *where the assistant runs* still
> stands and is what shipped: Symplist publishes tools over MCP and runs no agent. What did not survive
> is phase 3 — the offline, accountless, stdio-MCP install. Its server half was built (a declared
> deployment, one local owner, the local drivers) and then deleted. The reason is the same one that
> deleted the agent twice: a second production topology is a permanent correctness cost, and nobody had
> asked for this one. There is one mode now, the cloud, and `apps/desktop` is a window onto it.

## The thesis, which did not change

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

## The correction

The first version of this note drew the obvious conclusion: to execute, the agent needs a CLI, so
ship the agent on the desktop. That was half right, and the wrong half is the half we built.

Claude Code **is** the CLI. So is Claude Desktop, so is Cursor, so is whatever comes next. Each one
already has a mature chat surface, a permission model, context management, model selection — and a
shell in the user's *actual* repository. What they do not have is Symplist's tools.

So Symplist publishes its tools and does not run an agent. The api already speaks MCP: thirteen
tools over `/mcp`, with the full authorization flow — dynamic client registration, an authorize
endpoint, a consent screen — so connecting is a browser round trip the owner approves rather than a
token to paste. Point the client you already use at Symplist and it can read your task document,
rewrite a section, create tasks and search *and* run your tests, in your repository, with your key.

That is strictly more capable than what we built, and it is less of ours to maintain. What we shipped
in phase 2 was a sandboxed `dsh` child pinned to one directory we chose, with no plans, no todos, no
terminals and no elicitation, because `dsh-acp` omits all of them. It cost a 258MB vendored tree, a
release-candidate dependency, a resident Node process, and a screen asking people to paste an OpenAI
key into our app — under a comment admitting the keychain does not protect that key from the agent.

Every line of it is deleted. The thesis is intact; the mechanism was wrong.

## What Symplist is

A list. Tasks, one Markdown document each with real Git history, scheduling, search, Vault, sharing —
and an MCP endpoint your assistant connects to.

Two modes, and no third:

- **Cloud mode.** The list, everywhere. Web and desktop both read the same account. Your assistant
  connects to `<api>/mcp` over OAuth.
- **Local mode.** The list, fully offline. No account, no api, no network. Your assistant connects to
  a local MCP server over stdio.

This is the Obsidian arrangement, and the comparison is the design rather than a slogan. Obsidian is
a local application over local files, with sync you may switch on; nothing about the product depends
on the server existing. And Obsidian's answer to AI was never an embedded agent — it was files and an
API. Ours is tools and an endpoint.

### Consequences accepted deliberately

- **No assistant without a client.** Someone with no MCP client gets a very good list and no
  assistant. With one beta user who lives in Claude Code this costs nothing today; it is still a real
  decision, and the honest answer to "where is the chat?" is "in the tool you already have open".
- **Simon is no longer a character.** The approval cards, the working strip, the model picker and the
  persona are gone. The assistant is *yours*, holding our tools. That is the honest version.
- **Transcripts are not ours at all.** Not in the cloud, not on the device. Your client keeps its own
  history, which removes the sharpest edge in the original design — turn content crossing a
  third-party platform in plaintext — by removing the content.
- **We never touch a model credential.** Not in D1, not in a keychain. The client that calls the
  provider is the one that holds the key. This stops being a property we enforce and becomes one we
  cannot violate.
- **No connector layer.** Composio is gone. Your client brings Gmail, Slack, Linear and Drive if it
  wants them, and better than we did.

## Why the desktop app still exists

Not for the agent. For local mode.

What earns it: a window over the same frontend, a cloud session held in the main process so the
renderer holds no token, the OS keychain for `CONTENT_KEK`, native notifications, and — the point —
somewhere for a local database to live. Until local mode ships it is a cloud-mode wrapper, which is a
thin thing to ship and an honest one.

## The phases

### Phase 1 — Strip chat from the cloud — **done**

`packages/agent`, `core/src/simon`, `core/src/ai`, `web/features/simon`, `api/modules/simon`,
`worker/trigger/simon` and the BYOK contracts are gone, and with them approvals, transcripts and run
authority. Tables stay — migrations are expand-only — and stop being written.

### Phase 2 — The desktop shell — **done, then corrected**

An Electron app carrying the frontend, signing in to the cloud, with the session in main. It was also
built to host `dsh` over ACP; that half is deleted. Electron rather than Tauri still holds for local
mode: a Node runtime is already embedded.

macOS first, Windows after. Unsigned until a Developer ID exists.

**Done when:** the app installs, connects to the cloud account, and shows the workspace. It does.

### Phase 3 — Local mode

The same application with no cloud: local SQLite through the existing `DATA_DRIVER=local` path, an
in-process scheduler in place of Trigger, no account and no session.

The twelve generated secret families are generated on first run — `CONTENT_KEK`, `VAULT_RECOVERY_KEY`,
the digest secrets, the signing keys. Nothing is ever typed, because there is no model key to type.
`CONTENT_KEK` goes to the macOS Keychain or the Windows Credential Manager, with a one-time
instruction to back the recovery key up: offline there is no operator to recover anything.

It also ships a **local MCP server** over stdio, so the assistant story is the same one, with a
different transport and a JSON block in a client config instead of an OAuth round trip.

Local mode has no D1 budget lane, so it has none of the per-request cost the cloud pays.

**Done when:** a fresh install with no account can create tasks, write documents, and be driven from
Claude Desktop over stdio.

### Phase 4 — Promotion

Moving from local to cloud, once, without losing anything.

The desktop walks its local database and pushes batches; a Trigger task performs cloud-side
ingestion, indexing and verification. It cannot be the other way around — a Trigger task cannot read
the user's disk. Data is decrypted locally and **re-encrypted under the cloud account data key before
it leaves the machine**; plaintext exists only in memory on the user's own computer.

**Done when:** a local install with real data connects, redeems a beta code, and arrives in the cloud
complete and readable.

## The work that replaces the agent

Making the endpoint excellent, which is a tenth of the harness lane and worth more:

- **Resources.** We serve tools and no resources. Resources would let a client browse and attach task
  documents as context. This is the largest single win available.
- **Prompts.** "Triage my inbox", "write up this week" as first-class entry points.
- **Tools shaped for someone else's agent.** The thirteen were designed for ours: a richer
  `task_context`, more forgiving section addressing, errors that explain themselves.
- **The local stdio server**, which is phase 3's whole assistant story.

## Open questions

- Whether reminders remain the only reason the cloud runs scheduled work, and whether that is worth a
  Trigger dependency on its own.
- Whether the beta needs a first-run page that explains connecting a client, or whether the Agent
  connections screen is enough.
- Whether local mode's MCP server should also be offered in cloud mode, so a client can reach the
  workspace without a round trip to the api.
