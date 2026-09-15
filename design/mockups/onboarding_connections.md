# Onboarding — optional connections

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design a short invitation to connect useful services. Heading: “Connect what you use.” Copy: “You can do this later.” Show at most three or four example connector tiles in the initial view; Gmail, Google Calendar, and GitHub are proposed examples, not a confirmed launch catalogue. Mark catalogue assumptions in annotations.

Each tile has the service icon/name, a concise purpose, and Connect. Connected tiles show the selected account, a success state, and Manage. Provide equally clear Continue and Skip for now actions. No connector is required to enter the app or use native task/document tools.

Prototype one tile opening the provider-hosted authorization handoff, returning successfully, and continuing into an empty Now inbox. Do not recreate a fake provider credential form. Include popup blocked, user cancelled authorization, callback failed, connecting, and partial success across multiple connectors.

If no connectors are configured by a self-hosted operator, show a short neutral message and Continue. Do not display broken tiles or an upsell. Show that connector permissions govern what the agent can do and that consequential actions may still require confirmation.

Keep explanation brief and avoid overwhelming OAuth scope walls; detailed access information can expand on demand. Mobile tiles stack comfortably. A user who skips can find the same capabilities in Settings → Connections.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
