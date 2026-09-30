# @symplist/desktop

The Symplist desktop shell: the existing Next.js frontend in an Electron window, with the assistant
running on this machine. Phase 2 of `docs/notes/files/18_local_first_desktop.md`.

This package is the shell and the assistant bridge. The chat UI lands on top of it in `apps/web`; the
seams it attaches to are listed at the bottom.

## The three processes

| Process | Runs | Owns |
| --- | --- | --- |
| **main** | Electron's Node 24 | the renderer's Next server, the cloud session and its cookie jar, the OS keychain, and the harness child |
| **renderer** | Chromium, sandboxed | the unchanged `apps/web` frontend. No Node, no session, no network of its own |
| **dsh** | a child process per workspace root | the assistant: the agent loop, the shell, the filesystem sandbox. Driven over ACP on stdio |

**Cloud traffic runs in main, and moving it back would break sign-in.** The api pins its first-party
origin: `apps/api/src/common/route-classes.ts` requires `Origin === WEB_ORIGIN` for the pre-session
routes on every method, CORS allows exactly one origin, the session cookie is `__Host-sym_session` with
`SameSite=Lax`, and the WebSocket upgrade refuses a foreign `Origin` before it looks at the session. A
page served from `http://127.0.0.1:<port>` is cross-site to all of that. Plain Node is subject to none of
it, so main sets the header itself and the api needs no change, no new endpoint and no widened allowlist.

The cost is worth stating: after this, the `Origin` header no longer identifies which first-party client
is calling. A per-client rate lane or a desktop-only route would need a deliberate api change.

**The loopback listener is safe because it is dataless.** Any local process — and a remote page via DNS
rebinding — can reach `http://127.0.0.1:<port>`. What it gets is the app shell and nothing else, because
the renderer holds no session, no cookie and no key. That stops being true the moment someone "simplifies"
by putting the session back in the renderer.

## Running it

```bash
# From the repo root. Node 24 must be first on PATH.
pnpm --filter @symplist/desktop build          # bundle main + preload into dist/
pnpm --filter @symplist/desktop build:web      # build apps/web with SYMPLIST_DESKTOP=1 into build/web
pnpm --filter @symplist/desktop start          # launch the app
```

Against a dev server instead of the staged build — the single switch between development and a packaged
app:

```bash
pnpm --filter @symplist/web dev
SYMPLIST_DESKTOP_DEV_SERVER_URL=http://127.0.0.1:3000 pnpm --filter @symplist/desktop start
```

`SYMPLIST_DESKTOP_SMOKE_CAPTURE=/path/to/shot.png` boots the app, writes the first painted frame to that
path and quits, which is how "the window opens and shows the frontend" gets verified without a human at
the keyboard.

## Packaging

```bash
pnpm --filter @symplist/desktop package:mac    # unsigned arm64 .dmg into release/
```

Unsigned is deliberate for phase 2: there is no Developer ID yet, so `mac.identity` is `null` and
`CSC_IDENTITY_AUTO_DISCOVERY=false`, which keeps the build identical on every machine.

**A downloaded unsigned app is quarantined by macOS** and reports that it "is damaged and can't be
opened". It is not damaged. Either right-click the app in `/Applications` and choose **Open**, or clear
the flag:

```bash
xattr -dr com.apple.quarantine /Applications/Symplist.app
```

Verify a build by copying the `.dmg` somewhere clean, mounting it and dragging to `/Applications` —
launching from the build directory never sees quarantine, so it proves nothing about what a user gets.

## Where things go

```
src/shared/     contracts main and preload both hold: channel names, payload types, the window.symplist shape
src/main/       everything privileged
  index.ts        lifecycle: single instance, session hardening, boot order, quit
  window.ts       the BrowserWindow and its navigation lockdown
  navigation.ts   pure policy: what is internal, what may leave, which frame may call IPC
  next-server.ts  the staged frontend as a loopback server
  ipc.ts          the channel registry — every capability the renderer can reach
  log.ts          structured events, and the redaction that covers child process output
  smoke.ts        screenshot-and-exit, env-gated
  config.ts       the cloud's two origins, normalised; build-time for the closed beta
  cloud/          everything that talks to the api
    http.ts         the one outbound function, and the one place `Origin` is set
    cookie-jar.ts   two tiers: the session cookie is persisted, the Vault cookie is not
    session-state.ts restore on launch, persist on verify, clear on revocation or sign-out
    ipc.ts          the renderer's cloud capability, pinned to the api origin under /v1/
    mcp-grant.ts    the key dsh authenticates to Symplist's own MCP server with
  harness/        the assistant: one dsh child per workspace root, driven over ACP
    supervisor.ts   spawn, session map, approvals, idle reap, dispose-on-quit
    acp-client.ts   the ClientSideConnection and the Client half of the protocol
    locate.ts       pure: which candidate directory holds a usable harness tree
    profile.ts      pure: the generated dsh profile, including the disabled rows
    profile-writer.ts   puts those three files in userData before each spawn
    updates.ts      pure: ACP session updates projected onto the chat timeline
    provider-keys.ts    the device's model keys, read out of the keychain
  assistant-ipc.ts  the renderer's assistant capability, and its argument validation
  secrets/
    secret-store.ts named values under safeStorage; the app's one secret mechanism
src/preload/    the contextBridge surface: thin wrappers over named channels, nothing else
src/packaging/  assertions about electron-builder.yml
scripts/        build (esbuild), stage-web, start, package
```

### Cloud sign-in

Sign-in is the web app's own screens (`apps/web/src/features/access/signin`) over a different wire. The
renderer has **no network reach to the api at all**: `getApiClient()` in `apps/web/src/lib/api/client.ts`
detects `window.symplist.cloud` and builds its `ApiClient` with that `fetch` and that origin, so every
`/v1` call is made by main, which holds the session cookie and sets `Origin: WEB_ORIGIN`.

That header is the reason any of this is shaped the way it is. `RouteClassGuard.checkOrigin` compares
`Origin` to the api's configured `WEB_ORIGIN` by string equality — on **every** method for the
`pre_session` sign-in routes — and a Chromium renderer cannot set that header. A renderer served from
`http://127.0.0.1:<port>` is also not same-site with the api host, so Chromium would withhold the
`SameSite=Lax` session cookie even if CORS were satisfied. Only a non-browser client can meet those rules
honestly, and `apps/e2e/src/helpers/phase-e.ts` already calls the api exactly this way.

The cost is worth saying plainly: for this client the `Origin` header is decorative. The defences that
matter are unchanged — the session cookie's secrecy and the session-bound CSRF token — but if the api ever
tightens to `Origin` plus `Sec-Fetch-Site`, the desktop breaks. The header is set in exactly one function
(`cloud/http.ts`) so there is one place to change.

Four rules that must not be softened:

- **The session lives in main and only in main.** The IPC boundary is the security boundary: `Cookie` is
  never accepted from the renderer and `Set-Cookie` is never returned to it. This is also what makes the
  loopback listener acceptable, so putting a token back in the renderer breaks two things at once.
- **The Vault cookie is memory-only.** `cookie-jar.ts` keeps two tiers and only the session tier can be
  reached by the persister, so a restart can never leave a vault silently unlocked.
- **There is no plaintext fallback for a secret.** When `safeStorage.isEncryptionAvailable()` is false the
  app signs in on every launch. Users report that as a bug; a readable session cookie would be worse.
- **Nothing reads the keychain before `app.whenReady()`.** Measured on Electron 44 / macOS:
  `isEncryptionAvailable()` answers `false` before ready and `true` after, so a store consulted too early
  concludes the machine cannot encrypt and quietly stops persisting.

Two things follow from the api's own design rather than from this code. Sessions have a **30-day absolute
lifetime that activity never extends** (`SESSION_LIFETIME_MS`) and there is no refresh token, so every
desktop user re-enters an email code at least monthly — by design, not a bug. And the realtime socket is
**off** in phase 2 (`RealtimeUpgradeGate` wants an `Origin` a renderer cannot supply), so a session revoked
from another device is noticed on the next request, which main reports to the renderer over
`symplist:cloud/session-ended`.

`POST /v1/mcp/grants` hands its key back exactly once, so the grant is minted at sign-in and kept in the
keychain. A grant **outlives** the session that created it, which fixes an ordering: the revoke goes out
*before* `POST /v1/auth/logout`, because the session is what authorizes it. If that revoke could not be
sent — an offline sign-out — the key is still live at the api and `McpGrantStore.lastRevoke()` says so, so
the app can be honest about it instead of claiming a clean sign-out.

## The assistant

`harness/launch-acp.mjs` boots the DeepSeek Harness as an ACP server on stdio, and
`src/main/harness/supervisor.ts` is its only client. Six decisions carry the design, and every one of
them is something dsh already settled:

**It is a child process, not an import.** `dsh-acp`'s `stream` config is labelled "runtime-only
transport override; production uses stdio", `dsh-acp-app` claims stdout for protocol frames and binds
process lifetime to stdin EOF, and `installFailLoud` exits the process on an unhandled rejection. All
three own the process they run in, and an Electron main process cannot hand any of them over. It is
spawned as `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, so no second Node ships — Electron 44
embeds Node 24.21.0, inside the repo's own `>=24.15.0 <25` range, and every native addon in the tree
is Node-API. `utilityProcess.fork` would be the tidier primitive and cannot be used: it exposes no
writable stdin, and ACP is a stdin/stdout protocol.

**It is booted as an application-owned profile, not through the CLI.** `dsh/lib/bin.js` refuses the
name outright — *profile "desktop" is managed exclusively by the Electron application* — and
`dsh-app-boot` documents the path instead: "Application-owned npm projects, such as Electron's reserved
Desktop profile, use `loadProfileDirectory`". The launcher does by hand what `runProfile` does, minus
live patch watching, `--patch` overlays, the home-level patch layer and proxy installation.

Two things in it were found by running it rather than by reading:

- `provideCmdline` **must** include `ready`. `dsh-acp-app` refuses to mount without it — *the launcher
  must provide ctx.appExit and ctx.appReady before the tree mounts* — because it binds process lifetime
  to stdin EOF and must not arm that before startup succeeded.
- `boot`'s `bareModuleBaseUrl` is the wrong tool here, despite being documented for exactly this case.
  It resolves every bare specifier against one directory, and npm's hoisting of a 230-package
  release-candidate tree is not flat: a peer conflict pushes the whole `@deepseek-ai` set under
  `node_modules/@deepseek-ai/dsh/node_modules`. The launcher instead anchors on the dsh installation's
  own `package.json` and lets `healProfilesModuleFallback` mirror the dependency closure into
  `$DSH_HOME/profiles/node_modules`, which is what dsh itself does. That also keeps one Cordis instance
  in play, since `resolveBundleDir` resolves every profile bundle from the same anchor.

**The profile is generated into `userData` on every launch.** dsh rewrites `cordis.yml` at each boot
deliberately, because the Loader's tree write-back can bake composed rows into it and a stale copy
would duplicate every bundle insert next time. A profile inside a read-only `Resources` directory
therefore fails with `EROFS` or silently corrupts itself. The generated `cordis.patch.yml` is where
Symplist's policy over ~230 plugins lives: the provider routes, the `acp` row's default, and
`disabled: true` for `session-telemetry-otel` (OTLP export to a DeepSeek endpoint, and a row can only
be switched off by a patch), `web-search-deepseek`, `tool-web` and `llm-deepseek` — that last one
because, left mounted, its whole model catalog appears in the picker for an account that has no
DeepSeek key and never will.

**BYOK stays BYOK, on the device.** The key is read from the keychain and injected as the child's
launch environment, which `dsh-credentials-local` resolves `apiKeyEnv` references against per request
with the precedence *launch environment > stored file > project `.env` > home `.env`*. The launch layer
is read-only, so nothing in dsh can persist a key to `$DSH_HOME/.credentials.yaml`, and no file the
harness reads ever contains one — only the variable's name. Only routes whose key is actually present
are emitted, so the model catalog advertises exactly what can work; with no key at all no child is
spawned and the renderer shows the "add a key" state, the desktop heir of the cloud's
`ai.key_required`.

The limit belongs in the product too, not only here: **the key in the child's environment is not
behind a boundary.** The agent has a shell and runs as the user. The keychain protects the key at rest
across restarts; it does not protect it from the agent. dsh says the same of its own file permissions —
they "cannot keep provider keys away from its own agent".

**Approvals stay ours.** `session/request_permission` is a request main must answer, so it crosses to
the renderer as an event carrying a `requestId` and comes back through `assistant/decide`. dsh's own
human-in-the-loop mechanism is never delegated to. A cancellation releases every approval its turn was
blocked on with `cancelled`, which ACP requires — left unanswered, the agent waits for a decision that
will never come.

**There is no token stream.** `dsh-acp` emits `agent_message_chunk` from a *committed*
`assistant/message` event and states the commitment plainly: "standard semantic updates only… raw
provider deltas stay off the wire". `prompt` is therefore one IPC call that settles at the stop reason,
and the chat UI gets whole messages, thoughts and a tool-call lifecycle. A UI built around a typewriter
will sit still between tool calls; render the tool timeline, which is where a turn's time actually goes.

### Vendoring it

```bash
pnpm --filter @symplist/desktop vendor:harness   # ~290MB installed, ~200MB after pruning
```

`scripts/vendor-harness.mjs` installs one pinned dependency — `@deepseek-ai/dsh@0.1.5-rc.2` — into
`build/harness` with **npm**, not pnpm: electron-builder cannot pack a symlink farm, and dsh's own
profile scaffolding asks for `nodeLinker: hoisted` and `autoInstallPeers: false` for the same reason.
Two flags that look like improvements make it worse, and both were measured: `--install-strategy=hoisted`
and `--omit=dev` each *nest* the tree instead of flattening it, leaving the launcher unable to resolve
dsh from the root. `electron-builder.yml` ships the result as `extraResources` → `Resources/harness`,
outside `app.asar`, because four of its packages load Node-API addons from disk.

`SYMPLIST_DSH_HARNESS=/path/to/tree` overrides the lookup, which is how the harness is driven against a
tree that is not the one this build vendored.

**Test the dmg, not the dev run.** A missing `.node` file, a dereferenced symlink and a
write into `Resources` all work perfectly under `electron .` and fail only in the packaged app.

The trap that caught this once: `extraResources` cannot carry a `node_modules` directory sitting at the
root of a mapping's `from`. app-builder-lib's `createFilter` rejects the relative path `node_modules`
outright, before any `filter` pattern is consulted, so `from: build/web` shipped the standalone server
without the `.pnpm` store its `node_modules/next` symlink points at, and `from: build/harness` shipped
the launcher without dsh — a dmg that built, mounted, installed and then died on `Cannot find module
'next'` with nothing on screen. Both trees are therefore copied by the single `from: build` mapping,
which puts them at `web/node_modules` and `harness/node_modules`, one level below the root the filter
objects to. `src/packaging/electron-builder.test.ts` holds that shape in place.

### Seams for the lanes still to come

- **A new main-process capability** is a group in `src/main/ipc.ts`. Register it through the local
  `handle()` so it inherits the sender check — top frame, renderer origin — for free. Never expose a raw
  `fetch`, a raw `spawn`, or a secret's value: the renderer asks for an effect, not a credential.
- **A new service** (the keychain's write side for Settings → Models) is a directory under `src/main/`,
  constructed in `start()` in `index.ts` and passed to `registerIpcHandlers`. Keep the policy decisions in
  pure functions beside it, the way `navigation.ts` sits beside `window.ts`, so they are testable without
  Electron: a test that imports `electron` gets a path string, not the API.
- **A new renderer capability** is a namespace on the bridge in `src/preload/index.ts` and a method on
  `SymplistBridge` in `src/shared/bridge.ts`. `apps/web` matches that type structurally rather than
  importing it — the web app must not depend on this package — so a change here is a change to a
  published contract.
- **Renderer-side code does not live here.** It lives in `apps/web`, behind a `window.symplist` feature
  detection, which is what keeps one frontend for the browser and the desktop. The two seams that make
  that possible are `ApiClientOptions.fetch` in `apps/web/src/lib/api/client.ts` and the injectable
  `createSocket` in `apps/web/src/lib/realtime/client.ts`. If either grows a desktop-only branch inside a
  feature component instead of staying at the seam, the divergence this design exists to prevent starts
  anyway.
- **The assistant is announced through `HostInfo.assistant`**, which is whether this build carries a
  harness tree at all. The chat slot in `apps/web` mounts on that flag, so a shell with no harness shows
  no chat rather than a chat that cannot reply. It is deliberately *not* readiness: a device with a
  harness and no provider key still shows chat, because chat is where the "add a key" state belongs.
  `window.symplist.assistant.status()` answers that question, with a distinct reason for each thing the
  user can do about it — `harness_missing`, `key_required`, `boot_failed`, `provider_failed`.
- **The model key's write side is not built.** `src/main/harness/provider-keys.ts` reads
  `model-key-openai` and `model-key-anthropic` out of the existing `SecretStore`; Settings → Models has
  to write them under those names, and the names are exported from that module so both ends agree.
- **The ACP session id is not persisted.** `HarnessSupervisor` takes an optional `sessionBook`
  (`get` / `set` / `forget`) and uses it to `session/list` and `session/resume` on relaunch. Without
  one, every conversation starts a fresh session after a restart — the user's transcript survives, the
  agent's context does not. The local transcript store is where that interface should be implemented.
