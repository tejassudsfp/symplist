# Persistent task chat and agent activity

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Name the assistant **Simon** in the header and message attribution. Simon's meta tools can discover capabilities, inspect task context, request a connection, and ask a concise question. Show these as ordinary inline activity/prompts, not separate chats or an administrative rule editor.

Design the right panel for one selected task, with a header tied to the task, collapse action, conversation, and bottom composer. Fast/Smart selection is compact and applies to the next run. It must never show a price, plan lock, upgrade link, or credit meter in beta.

Use a concrete conversation: user asks “Help me tighten the Projects section.” Activity shows “Reading Projects to feature,” then “Updating Projects to feature,” followed by a concise result and a link to the changed section. Expanded tool details can show which section was read, not a full injected document or hidden model reasoning.

Show first message/empty chat; typing; submitted/queued; streaming text; tool activity; awaiting user approval; completed; user-stopped with partial response preserved; provider error; temporary reconnect; interrupted run with explicit retry; and AI unavailable because the operator has not configured it. Conversation history remains viewable where access permits.

New user messages during a run are visibly queued with a clear pending indicator. Do not promise immediate steering unless annotated as a future option. A Stop control acts on the current run and does not erase output. Closing the panel or switching tasks does not stop the agent.

The composer supports multiline input and clear send behavior without becoming a command console. No terminal, sandbox, model marketplace, or constant technical logs. On mobile show full-width chat and a Page switch. Include tool error and retry copy that avoids repeating uncertain external actions automatically.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.

## Confirmed history behavior

Add a compact “Checking changes since last read” tool-activity state, followed by section names marked Added / Modified / Removed. This list comes from deterministic parsing/diffing, not a separate summarization agent. No new chat, background AI task, or summary-generation spinner is involved.

## Integration activity naming

Simon owns the visible tool-call presentation. Show action labels such as “Checking your calendar” with the actual connected account/service, rather than COMPOSIO_SEARCH_TOOLS or other raw upstream names. Connection consent disclosures remain accurate. No new meta-tool dashboard is needed.

## Keyboard coverage

Follow the shared [keyboard map](../../docs/notes/files/13_keyboard_shortcuts.md). Show applicable menu hints, visible focus, next/previous task behavior, Page/Chat focus switching, and search entry. Navigation shortcuts must not activate while the user types. Include keyboard-only operation in the prototype and preserve drafts when focus/tasks change.

## Specialist handoff and artifact actions

Follow [Handoff](handoff.md), [Share artifact](artifact_share.md), and [Manage links](artifact_shares.md). Simon can prepare full specialist instructions from bounded task context; it does not perform heavy coding/deep research itself. Show editable prompt and reviewed release as separate steps. No link is published or sent merely because a suggestion appears. Existing task chat remains the same conversation.
