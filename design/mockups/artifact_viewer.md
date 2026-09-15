# Standalone read-only artifact

Read [overall.md](overall.md), [themes.md](themes.md), and [handoff and sharing requirements](../../docs/notes/files/16_simon_handoffs_and_artifact_sharing.md). Derive visual treatment from the supplied UI sample.

## Surface and flow

Design a minimal signed-out document surface at the artifact URL. Only title, approved Markdown, optional reviewed source-version label, and expiry appear with tiny unobtrusive product attribution. Include Copy content/Download Markdown if authorized, and a raw-text alternative. No application rail, inbox, task chat, owner profile, connectors, workspace navigation, or related-document listing. Match the sample typography and calm styling; long documents remain readable on mobile.

## Required states

Cover link-only/public content, password entry and invalid password/rate limit, unlocked password session, long headings/code/table content, loading/network failure, download, and generic unavailable for expired/revoked/unknown links. Unavailable state reveals no private title. Prototype must not require signup or app beta access to read a valid share. Content must render server-side for no-JavaScript clients. Read-only means no edit, comments, task-completion, or incoming-MCP actions.

## Handoff to implementation

Provide desktop and mobile frames, accessible controls, focus/escape behavior, success and failure transitions, and preserved task context. Apply independent style/accent/brightness tokens. Use fictional content and nonfunctional links; annotate authorization and persistence boundaries. Include a keyboard-only prototype from task to this surface and back.
