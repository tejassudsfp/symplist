# Settings — connect third-party agents via MCP

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design a settings screen named “Agent connections” with a concise explanation: “Let another agent work with selected Symplist tasks.” MCP may appear as a secondary technical label because it helps users configure an external agent.

Show a configured server address with Copy, an Add connection action, and a list of authorized clients with name, task scope, permissions, creation/last-used metadata, and Revoke. Use a clearly placeholder endpoint, not an invented live service. Connection setup fields and access tokens are proposals pending the final MCP auth implementation.

For a setup detail view, propose a named connection, selected-task or broader explicit scope, and permissions such as Read tasks, Edit pages, and Start AI work. Make broader access deliberate. A short copyable configuration example can be shown when needed; secrets remain masked and are only revealed once where the auth method requires it.

Show no connections, create/configure, copy success, failed validation, connected, expired credential, revoke confirmation, and revoked. Admins do not get access to other users' private conversations through this page. Beta access rules still govern calls; an authorized client cannot bypass a locked account.

No sandbox or terminal launcher. Do not conflate incoming external agents with service connectors. Include mobile setup readability and explain how to return to the task that initiated setup.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
