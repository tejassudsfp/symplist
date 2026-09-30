# @symplist/desktop

Symplist on the desktop: the existing Next.js frontend in an Electron window, with the cloud session
held in the main process. Phase 2 of `docs/notes/files/18_local_first_desktop.md`.

**It hosts no assistant, and that is the decision rather than the gap.** An earlier version of this
package ran the DeepSeek Harness as a child over ACP, with a model keychain, a loopback MCP relay and a
local transcript store. All of it is deleted. Symplist publishes its tools over the api's `/mcp`
endpoint and the assistant is whichever MCP client the person already uses — which has their real shell
in their real repository, and holds their own model key. See note 18 for the full argument.

So this package is a shell. What earns it is local mode (phase 3): somewhere for a local database to
live, and the OS keychain for the content key.

## The two processes

| Process | Runs | Owns |
| --- | --- | --- |
| **main** | Electron's Node 24 | the renderer's Next server, the cloud session and its cookie jar, the OS keychain, the menu-bar item and the Vault popover's window |
| **renderer** | Chromium, sandboxed | the unchanged `apps/web` frontend, in two windows — the workspace and the Vault panel. No Node, no session, no network of its own |

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

Unsigned is deliberate for now: there is no Developer ID yet, so `mac.identity` is `null` and
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
  tray.ts         the menu-bar item: left-click toggles the Vault panel, right-click is the native menu
  tray-icon.ts    pure geometry: the padlock, closed and open, as a PNG data URL at 1x and 2x
  vault-window.ts the Vault popover's window — placed, hidden on blur, and locking what it opened
  vault-panel.ts  pure policy beside it: where the panel goes, what it may report, what it may open
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
    session-hint.ts the non-secret cookie the proxy reads, mirrored onto the renderer's origin
  node-runner.ts  which binary a Node child is spawned from, so it takes no second Dock icon
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

## The Vault quick-access panel

A padlock in the menu bar opens a 320 px popover under it with the vault in it, and nothing else from
Symplist. ⇧⌘V opens it from any application, ↑↓ and ↵ copy an item's value without showing it, ⌘L locks,
escape closes. The icon is drawn open while the vault is unlocked, so its state is readable from the menu
bar without opening anything.

It is the vault the api already has. The page is `apps/web`'s `/desktop/vault`, so it inherits the
person's theme from the same `sym_appearance` cookie the workspace reads, calls the same `/v1/vault`
routes through the same `cloud` bridge, and holds no token for the same reason the workspace holds none.
No route, contract or api change was needed, and there is no second vault implementation to keep correct.

Four things this package adds, and why each one could not live in the page:

- **The window.** A frameless popover hung off a tray item, hidden rather than closed so reopening is
  instant, and sized to the panel's measured content the way each state of the mockup is.
- **The clipboard.** `hardenSession()` refuses every device permission, so the renderer cannot write one
  — and the 30-second clear has to outlive a panel that is already hidden. It clears only if the
  clipboard still holds what Symplist put there.
- **The lock.** Closing the panel locks the vault it opened, and only that one: a single vault session
  serves both windows, so a panel that locked unconditionally would relock the vault someone was working
  in. The renderer sends `POST /v1/vault/lock` — the request that revokes the session at the api and
  publishes `vault.locked`, which is what makes the workspace's vault screen clear too — and main drops
  the vault cookie from the jar a moment later as the half that cannot fail.
- **The menu-bar icon.** Drawn in code (`tray-icon.ts`) rather than shipped as two PNG files, for the
  reason the Symplist mark is drawn from arithmetic: the geometry is reviewable, it redraws identically at
  every scale factor, and a committed binary cannot be read in a diff. It is a macOS template image, so
  the system owns its colour and there is no second asset for dark mode.

The panel's five IPC channels are the only ones with a **second** sender check. The frame check in
`ipc.ts` cannot separate the popover from the workspace — same origin, both top frames — so each panel
channel asks the panel whether the sender is its own `webContents` first.

Two things the mockup shows that are not built, both deliberate. **Quick-access settings…** is not in the
tray menu, because there are no quick-access preferences and a menu item that leads nowhere is worse than
its absence. And an item's **Service** and **Note** fields are not shown: `vaultItemContentSchema` is
`{type, title, value}` and inventing two more would have meant an api change for a mockup detail. A secure
note's body appears under the mockup's `Note` label; a secret shows its value, masked.

## Where the assistant is

Not here. `apps/api/src/modules/mcp/` publishes 13 tools over `/mcp` with the full MCP authorization
flow — dynamic client registration, an authorize endpoint, a consent screen — so a person connects
Claude Desktop, Claude Code or anything else with a URL and an Approve button. Settings → Agent
connections in `apps/web` is where they manage that.

This app does not proxy it, and that is worth stating because the earlier version did: it ran a
loopback relay holding a `sym_` grant so a `dsh` child could reach Symplist's tools. Now the grant is
the person's own, minted by the api's consent screen, and no bearer token passes through this process
at all.

What that deletion took with it, so nobody goes looking: `main/harness/` (the supervisor, the ACP
client, the profile writer, the session book), `main/mcp/` (the relay, its policy, its reconciler),
`main/transcripts.ts` (the local SQLite conversation store), `assistant-ipc.ts`, `keychain-ipc.ts`,
`cloud/mcp-grant.ts`, `shared/assistant.ts`, `shared/keychain.ts`, `scripts/vendor-harness.mjs` and a
258MB vendored `@deepseek-ai/dsh` tree. `git log` has it if phase 3 ever wants a piece back — it will
not want the agent.

### Seams for local mode (phase 3)

- **A new main-process capability** is a group in `src/main/ipc.ts`. Register it through the local
  `handle()` so it inherits the sender check — top frame, renderer origin — for free. Never expose a raw
  `fetch`, a raw `spawn`, or a secret's value: the renderer asks for an effect, not a credential.
- **A new service** is a directory under `src/main/`, constructed in `start()` in `index.ts` and passed
  to `registerIpcHandlers`. Keep the policy decisions in pure functions beside it, the way
  `navigation.ts` sits beside `window.ts`, so they are testable without Electron: a test that imports
  `electron` gets a path string, not the API.
- **A new renderer capability** is a namespace on the bridge in `src/preload/index.ts` and a method on
  `SymplistBridge` in `src/shared/bridge.ts`. `apps/web` matches that type structurally rather than
  importing it — the web app must not depend on this package — so a change here is a change to a
  published contract.

  **Nothing that keeps its state on a prototype survives that boundary.** `contextBridge` copies own
  enumerable properties, so a `URL`, a `Headers`, an `AbortSignal` and a `Response` each arrive as `{}`.
  All four shipped as bugs: a URL that resolved to `/[object Object]`, requests with no `Content-Type`
  and no CSRF header answering 403, and a truthy `{}` signal whose missing `addEventListener` surfaced in
  the page as "You appear to be offline". `BridgedRequestInit` in `shared/bridge.ts` names the two
  members that cannot cross, so the next one is a compile error instead. Pass plain records, arrays,
  strings, numbers — and functions, which do survive.
- **Renderer-side code does not live here.** It lives in `apps/web`, behind a `window.symplist` feature
  detection, which is what keeps one frontend for the browser and the desktop. The two seams that make
  that possible are `ApiClientOptions.fetch` in `apps/web/src/lib/api/client.ts` and the injectable
  `createSocket` in `apps/web/src/lib/realtime/client.ts`. If either grows a desktop-only branch inside a
  feature component instead of staying at the seam, the divergence this design exists to prevent starts
  anyway.
- **A Node child must be spawned from `nodeRunnerPath()`**, not `process.execPath`. On macOS the latter
  is the bundle's own `MacOS/Symplist`, whose `Info.plist` has no `LSUIElement`, so launching it gives
  the child a second Dock icon that bounces and then sits there for the life of the app. The Electron
  helper bundle exists for exactly this. Nothing fails; it just looks like two apps opened.
- **Local mode needs a database, a scheduler and no session.** `DATA_DRIVER=local` already exists in
  `packages/db`, the twelve generated secret families get generated on first run, `CONTENT_KEK` goes into
  `SecretStore` (and wants a Keychain backup prompt), and the api's dispatch work becomes in-process.
  None of it is built.
- **Local mode also needs a local MCP server over stdio**, so the assistant story offline is the same
  one it is online with a different transport. That is the only assistant code this package should ever
  carry: a server publishing tools, never a client running a model.
