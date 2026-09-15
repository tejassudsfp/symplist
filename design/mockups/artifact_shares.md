# Manage task artifacts and shared links

Read [overall.md](overall.md), [themes.md](themes.md), and [handoff and sharing requirements](../../docs/notes/files/16_simon_handoffs_and_artifact_sharing.md). Derive visual treatment from the supplied UI sample.

## Surface and flow

Design a task-level Artifacts and links surface listing private snapshots and active/expired/revoked grants. Show artifact name, captured version, mode, expiry, created time, and concise status; no raw access tokens in listings. Offer preview, share, revoke, and create replacement. Mark public grants unmistakably. Multiple grants for one snapshot are independently managed.

## Required states

Show empty, mixed modes, expiry, relocked/disabled grants, confirmation, pending/failure, source newer than snapshot, and update-publication as a new snapshot/grant. Copy-again after initial creation uses the documented explicit replacement flow because raw tokens are not stored recoverably. Do not display invented unique-reader statistics. Include keyboard navigation, mobile list layout, and a link back to the existing task page/chat.

## Handoff to implementation

Provide desktop and mobile frames, accessible controls, focus/escape behavior, success and failure transitions, and preserved task context. Apply independent style/accent/brightness tokens. Use fictional content and nonfunctional links; annotate authorization and persistence boundaries. Include a keyboard-only prototype from task to this surface and back.
