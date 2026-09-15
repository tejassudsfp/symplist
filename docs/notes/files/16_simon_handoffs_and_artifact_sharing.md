# Simon's role, handoff mode, and read-only artifact sharing

Confirmed product direction, September 15, 2026. Documentation only; implementation is pending. This narrows earlier broad descriptions of task execution and adds handoff/sharing to the build scope.

## Simon is a productivity facilitator

Simon helps organize a task, clarify its intended outcome, maintain useful context, perform small authorized connector actions, manage deadlines, and prepare work for the right specialist. Symplist is not a replacement for general-purpose general-purpose assistants, a coding agent, or a deep-research service. Do not promise comparative model/subscription capabilities as fixed facts; the distinction is product scope.

Simon can structure an unstructured task note, identify missing requirements, draft a concise brief, and produce a complete actionable prompt for a coding assistant, a general-purpose assistant, or another destination. For substantial coding, deep research, or extended specialist work, offer a handoff with enough context to proceed. Do not merely refuse or claim the heavy work is finished. Do not introduce background specialist agents, autonomous coding, or research loops inside Symplist. Fast/Smart select the model for facilitation, not a different product remit.

Example: “Build my portfolio” → Simon reads relevant sections, clarifies audience and constraints, organizes the brief, and prepares a a coding assistant prompt with selected artifact links. The specialist builds; the user can paste/import its result or use separately authorized incoming MCP to bring it back. Reading a shared link never authorizes writing results into Symplist. No automatic external-agent launch or subscription integration is implied.

## Handoff flow

1. Enter Handoff from the task menu, command palette, or Simon's contextual suggestion. Choose the destination label and desired outcome. These labels describe prompt style; they are not claims of a live integration.
2. Simon reads bounded task metadata and relevant document sections using existing tools. Include actual deadline, placement, priority or other properties only when present; do not invent a priority/respect schema from an unclear note. Distinguish facts, unresolved questions, and assumptions.
3. Select artifact sources, exact saved revisions, and optional section subsets. Default to the current task document, not all task material. Unsaved text must be saved or explicitly captured as a reviewed new artifact before publication.
4. Generate an editable prompt containing objective, concrete instructions, constraints, supplied context, artifact inventory and purpose, expected output, acceptance checks, and how to return results. Readability and completeness matter more than prompt length. Do not claim unread context has been incorporated. Large artifacts remain fetchable progressively.
5. Review the exact exported content and access settings. Link creation/publishing is a separate explicit release action. Bind approval to snapshot/version, selection, visibility, expiry, and password policy. Source changes invalidate an unexecuted review; already released snapshots remain pinned.
6. Create links and assemble them into the reviewed prompt. Copy prompt, Copy link, and Download Markdown are available. Do not auto-send to another service/person. Include expiry with timezone and a fallback: request a fresh link or ask the user to paste/download the artifact if URL fetching is unavailable.
7. Show links and their lifecycle in the task sharing manager. Expiration does not delete the owner's original document. Regenerating an expired link requires a deliberate action and yields a new grant; it must not silently broaden access or reset a revoked link.

Drafting the prompt uses Simon's ordinary user-initiated model action. Snapshotting, encryption, links, expiry, revocation, and rendering are deterministic service work. No background summarization. The user can also share a document directly or write a handoff manually without AI.

## Artifact boundary and versions

An artifact is a named immutable Markdown snapshot, optionally assembled from explicitly selected sections. Each has an opaque ID, owner/task reference, captured source Git revision/section references, media type, content size, encrypted payload reference, and creation time. Draft handoff prompts may be saved as separate task-associated artifacts. The private original task document remains backed by actual Git.

Sharing defaults to a pinned snapshot. Later private edits never silently appear in an old share. Publishing an updated version creates a new artifact/link; offer explicit revoke-old as a separate option. Live-following document links are deferred. Each artifact can have independently revocable grants; public publication is a distinct grant, not a flag that accidentally bypasses password protection on another URL.

Only the selected Markdown is exported. No entire Git bundle/history, chat, parent/child tasks, connected account identity, hidden metadata, attachments, or Vault material is included implicitly. Vault sharing is outside this feature. Preserve user-visible provenance only if reviewed. Strip app-only/internal links or render them as inert labels; explicitly selected related artifacts receive their own grant. Do not forward original private object URLs, bearer tokens embedded in source text, or connector credentials. Automated warnings can help, but the preview must not promise perfect secret detection.

## Access modes

| Mode | Recipient requirement | Expiry/default | Intended use |
| --- | --- | --- | --- |
| Link-only | Possession of the full secret URL; no Symplist account | Proposed 24 hours; presets 1 hour/24 hours/7 days, configurable maximum 7 days | Short-lived person/agent handoff |
| Password-protected link | Secret URL plus separate password | Same expiry bounds | Human sharing or clients able to complete the password exchange |
| Public artifact | Public artifact URL, no secret/password/account | Explicit expiry or explicit Until revoked | Deliberate public read-only publication |

No mode grants editing, commenting, task listing, connector use, or MCP credentials. Public mode requires clear “Anyone can read this” confirmation; default it to expiring too. Public does not mean indexed/searchable: omit all shares from sitemap/search engines by default. Future discoverability is a separate feature. Warn in the review if the same snapshot also has an active public grant; a password does not make its publicly published copy private.

Anonymous recipients can read an explicitly shared artifact even though general app signup is beta-locked. This is a narrow share-route authorization path, not an exception for ordinary task APIs. Owner relock/suspension, deletion, artifact deletion, or grant revocation disables every affected share. Restoring owner access does not automatically reactivate disabled grants. Check these conditions on every read; cleanup jobs are not authorization.

## URL, encryption, and serving design

Use the existing service-readable encrypted-content model, not a new promise of end-to-end sharing. Proposed link-only URL: `https://<app-origin>/artifact/<artifact-id>?key=<random-share-token>`. A public publication can use `/artifact/<artifact-id>/public/<publication-id>` and resolves only that explicit public grant. Private artifact IDs alone grant nothing. Raw Markdown is available through the corresponding `/raw` route with the same grant checks. Format changes, HEAD requests, previews, and outline/section endpoints must never bypass protection.

Generate 32 random bytes per private share token using a cryptographic RNG, encode URL-safe, and store only a versioned HMAC-SHA-256 digest under a server-held share-digest secret. Compare safely. The URL token is an access capability, **not** the AES encryption key. Encrypt snapshots with AES-256-GCM using unique nonces and authenticated owner/artifact/version context; wrap random data keys under the existing key system. Password mode adds an Argon2id salted password verifier; never store/recover the plaintext password or use it as the sole recoverable content-encryption key. Changing password invalidates all issued access sessions for that grant.

Serve through Nest authorization/decryption, with a minimal server-rendered artifact surface. Keep R2 private and encrypted. Do not give recipients account keys or decrypted Git bundles. R2 presigned URLs authorize object access, not this application's password/revocation/decryption rules, so they are not the artifact-view access mechanism. See [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

Link-only HTML and raw Markdown must be readable through ordinary HTTPS GET without executing JavaScript or signing into Symplist. Include title, snapshot date/version label, content, and expiry where relevant; no app shell, chat, sidebar, or related-artifact discovery. Large content may offer a bounded outline and section URLs constrained to the same artifact/grant. The external agent chooses what to fetch; do not guarantee that any particular general-purpose assistants product can crawl arbitrary URLs. Raw text includes no private share-management metadata.

Password entry submits by POST, then establishes a short-lived HttpOnly Secure scoped session, capped at the grant expiry and checked against its current generation. Protect exchange endpoints against abuse and apply a documented bounded attempt policy. Never append a password to a URL or generated handoff prompt. Password-mode raw access requires the same authenticated share session. Show “Some agents cannot open password-protected links” with manual download/paste or separately approved short-lived link as alternatives; never downgrade access automatically.

Capability URLs can leak through logs and referrers. Suppress/redact the key in proxy/application/error/analytics logs, use HTTPS, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, and disable CDN/shared response caching for every artifact representation, including public ones initially. Render no third-party trackers, remote fonts, or remote images that could receive request context; sanitize Markdown/HTML, disallow executable embeds and unsafe links, and apply a restrictive CSP. No secret-token canonical/OG tags. Link previews themselves can fetch content; explain that anyone holding the link, including a recipient service, can read it. No single-use access counter by default: scanners and multi-request crawlers make that unreliable. See [W3C capability URL guidance](https://www.w3.org/TR/capability-urls/) and [OWASP response headers](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html).

Return a generic unavailable response without document title for unknown, revoked, expired, or inaccessible shares. Revocation stops future server reads; an in-flight response, saved download, provider context, or published copy cannot be recalled. Expiring links do not expire a recipient's copy. This limitation belongs in concise share-review copy, not a blocking lecture.

## Persistence, tools, and lifecycle

D1 records artifacts, grants/digests/password verifiers, source revision references, expiry/status/generation, approval/creation idempotency, and redacted audit events. Encrypt descriptive titles/prompt drafts under account policy; keep minimum queryable IDs/times/status explicit. Upload encrypted immutable artifacts before publishing a grant and record dispatch/result atomically where supported. Failed/unpublished artifacts are garbage-collected after a safe grace period. Never persist a plaintext full bearer URL in ordinary logs or chat history.

To support copy-again without recoverable raw tokens, store grant references in chat/handoff drafts and resolve active links only in the owner's authorized UI when initially created. Later copy-again creates a reviewed replacement token/grant (optionally revoking old) rather than pretending the digest can recover the original. Generated final prompt containing URLs is presented for immediate copy/download; saved prompt templates retain placeholders/grant references. A deliberate plaintext export contains capabilities and must be labeled accordingly. Tool responses to Simon should use references/placeholders; trusted UI assembly inserts real URLs after release, avoiding accidental model-provider exposure of share tokens.

Add native tool contracts:

- `handoff_prepare`: bounded source/task references, target, outcome, expected revisions → editable structured draft with unresolved questions and link placeholders. Prompt generation stays in the current Simon run.
- `artifact_snapshot`: explicitly selected revision/sections → private immutable artifact preview; no public access created.
- `artifact_share_create`: reviewed approval ID, artifact ID, mode, expiry, idempotency key → grant reference/status; password captured through trusted UI, never a model argument.
- `artifact_share_list` / `artifact_share_revoke`: owner/task-scoped redacted metadata and explicit revocation; no tokens returned in lists.

Expose appropriate scoped incoming MCP equivalents; caller-supplied approval flags cannot replace trusted approval records. Link access itself never permits calling these tools. `rules_read` gains role/handoff and artifact-sharing domains. The model cannot choose public mode merely because the document says “publish me.” UI direct sharing and tool paths use identical validation, preview, ownership, access, and approval rules.

Tool execution follows DURABLE selection; ordinary share reads remain Nest APIs in both modes. Optional expiry/cleanup jobs use Trigger when durable and Nest otherwise. Immediate expiry/revocation is enforced synchronously, independent of scheduler health. App search indexes owner-visible artifact metadata/content only through the established encrypted index policy; public URLs do not grant global search or owner enumeration.

## Build acceptance criteria

Verify a normal user can prepare a specialist prompt, review selected revision/sections, release a short-lived link, and open only that artifact in a signed-out browser and a plain HTTP client. Confirm independent document sharing without AI; password prompt/session/raw checks; public-grant isolation; expiry and revocation with scheduler offline; relock/delete; changed source and pinned snapshots; multiple grants; cancellation/approval replay; concurrent creation/idempotency; token rotation; interrupted publication recovery; restricted section pagination; sanitized Markdown and external media; no cache/referrer/log leaks; no Vault/chat/Git-history exposure; expired prompt links and manual fallback.

Test all 44 screen briefs including handoff/share states, both executors' tool contracts, and the previous full build scope. Verify Simon routes representative coding/deep-research requests into useful handoffs while still completing small allowed productivity actions. Validate actual live external-agent fetch behavior separately when credentials/product capabilities permit; never claim universal crawler compatibility from a local HTTP test.
