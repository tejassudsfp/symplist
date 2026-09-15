# Artifact share review

Read [overall.md](overall.md), [themes.md](themes.md), and [handoff and sharing requirements](../../docs/notes/files/16_simon_handoffs_and_artifact_sharing.md). Derive visual treatment from the supplied UI sample.

## Surface and flow

Design direct Share from a task document and the sharing step inside Handoff. Show exact snapshot/version and selected sections with a recipient preview. Offer Link-only, Password-protected, Public; explicit expiry and public Until revoked option. Default to a 24-hour link-only share. A password is entered in a trusted input outside Simon chat. Release button states the concrete mode, e.g. Create expiring link or Publish read-only artifact.

## Required states

Show no-links-yet, editing selection, active public copy warning, password fields/validation, unknown/unsaved source, creating, failed, created with Copy link, revoke, and create replacement. Clarify that future edits do not update the snapshot and already fetched copies cannot be recalled. Never show account keys, expose other documents, or imply password links are always agent-readable. No share is created just by opening the dialog.

## Handoff to implementation

Provide desktop and mobile frames, accessible controls, focus/escape behavior, success and failure transitions, and preserved task context. Apply independent style/accent/brightness tokens. Use fictional content and nonfunctional links; annotate authorization and persistence boundaries. Include a keyboard-only prototype from task to this surface and back.
