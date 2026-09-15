# Email and analytics research (verified 2026-09-15)

Scope: this covers transactional email (Resend plus React Email templates) and product analytics (PostHog on the web and on the server). In Symplist, login codes and Vault reset emails go out from NestJS on Render, and reminder emails go out from Trigger.dev v4 tasks. Resend webhooks come in to NestJS. PostHog runs on the Next.js frontend (Vercel) only after cookie consent. The backend and worker send allowlisted server events. Account deletion removes the user's PostHog person and events.

How this was checked:
- Versions come from `npm view` on 2026-09-15.
- API facts come from the official docs. Resend and React Email docs were read as Markdown (`*.md` pages listed in https://resend.com/docs/llms.txt and https://react.email/docs/llms.txt). PostHog docs came from https://posthog.com/llms.txt, and PostHog REST scopes came from the live OpenAPI schema at https://us.posthog.com/api/schema/.
- Every claim was also checked against the published `.d.ts`/`.d.mts` and `dist` code of the exact versions below.
- The snippets were type-checked as written with `tsc` 7.0.2 in a throwaway project. The NestJS controller was checked against `@nestjs/common` 12 types, and free variables were declared as stubs (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`). Negative tests (`idempotency_key`, `capture_pageviews`, `flush_at`, wrong webhook header keys) fail as expected, which shows the types are real and not `any`.
- Runtime checks ran on Node 24.15.0 with no network and no real accounts:
  - React Email rendered HTML and plain text.
  - `resend.webhooks.verify` accepted a correctly signed payload and rejected a tampered one and a 10-minute-old one.
  - `posthog-node` batches were captured through its `fetch` option.
  - `posthog-js` ran in jsdom 30 to observe storage, network and the event payload before and after consent.

## Versions

| Package | Version | Peer / engine notes |
| --- | --- | --- |
| `resend` | 6.28.0 (published 2026-09-11) | engines `node >=20`. Optional peer `@react-email/render: *`, used only by the `react:` send option through a dynamic `import()`. Deps: `standardwebhooks 1.0.0` (webhook verification) and `postal-mime 2.7.5`. Dual ESM/CJS `exports`. Built with `typescript 6.0.3`, with no `typescript` peer. The SDK has no retry logic. `6.28.0-preview-inboxes.0` exists and should be ignored. |
| `react-email` | 6.9.5 (2026-09-08) | peers `react`/`react-dom` `^18.0 \|\| ^19.0`. engines `node >=20.0.0`. Dep `@react-email/render >=2.1.0`. Since 6.0.0 this one package exports all components and `render`/`pretty`/`toPlainText`, and it also ships the `email` CLI. Dual ESM/CJS. No `typescript` dependency. |
| `@react-email/render` | 2.1.0 (2026-07-10) | peers `react`/`react-dom` `^18 \|\| ^19`. engines `node >=20.0.0`. Not deprecated. Deps `html-to-text`, `prettier`, `html5parser`, `entities`. It is re-exported by `react-email`, so add it directly only if we use Resend's `react:` option. |
| `@react-email/ui` | 6.9.5 | Dev-only preview server for `email dev`. Deps `next 16.3.3` and `esbuild 0.28.1`. |
| `@react-email/components` | 1.0.12 | **Deprecated on npm** ("Package no longer supported"). The react-email 6.0.0 changelog says to import from `react-email` instead. Do not use. |
| `react` / `react-dom` / `@types/react` | 19.3.0 | Satisfy the React Email peers. |
| `posthog-js` | 1.433.4 (2026-09-15) | peers `react >=16.8.0` and `@types/react >=16.8.0` (only for `posthog-js/react`). No `engines`. No `exports` map: `main` is CJS `dist/main.js`, `module` is `dist/module.mjs`, and `types` is `dist/module.d.ts`. Deps `@posthog/core ^1.54.1`, `@posthog/types`, `@posthog/browser-common`, `web-vitals`. It publishes almost daily, so pin the exact version. |
| `posthog-node` | 5.52.3 (2026-09-15) | engines `node ^20.20.0 \|\| >=22.22.0` (Node 24 is fine). Optional peer `rxjs ^7`. Dep `@posthog/core ^1.54.1`. Has `node`/`edge`/`workerd` export conditions. Pin the exact version. |
| `svix` | 2.5.0 | engines `node >=22`. **Not needed**, because `resend.webhooks.verify` covers verification. Use it only for manual verification. |
| `standardwebhooks` | 1.0.0 (transitive) | Pinned by `resend`. Rejects timestamps more than 5 minutes old or ahead (`WEBHOOK_TOLERANCE_IN_SECONDS = 5 * 60` in its dist). |
| `@types/html-to-text`, `@types/prismjs`, `@types/css-tree`, `@types/express` | 9.0.4, 1.26.6, 3.2.0, 5.0.6 | Needed only when `skipLibCheck: false` (see TypeScript 7 below). |
| `typescript` | 7.0.2 | Works with every package here. See the evidence below. |

TypeScript 7 evidence (experiment in the research scratchpad):
- Two configs had 0 errors on `tsc` 7.0.2 with `skipLibCheck: true`: `module/moduleResolution: nodenext` with `jsx: react-jsx` (for React Email, Resend, posthog-node), and `module: esnext` with `moduleResolution: bundler` (for posthog-js, matching Next.js and `apps/worker`). TS 7 also emitted the files, and the emitted JS ran on Node 24.
- `skipLibCheck: false` gave 14 errors, and `tsc` 6.0.3 gave the **same** 14, so the cause is not TS 7:
  - `@react-email/render` and `react-email` `.d.mts` import untyped `html-to-text`, `prismjs` and `css-tree`.
  - `posthog-node/dist/extensions/express.d.ts` imports `express`.
  - Under `nodenext`, a default import of `posthog-js` (a CJS-typed package with no `exports`) resolves to the module object, so `posthog.init` does not exist. Node's own ESM loader behaves the same at runtime.
- Fixes, all verified on TS 7 and TS 6: add the four `@types/*` dev deps (then `skipLibCheck: false` gives 0 errors), or keep `skipLibCheck: true` like `apps/worker`. Import `posthog-js` as a default only under `moduleResolution: bundler`; under `nodenext`, use `import { posthog } from 'posthog-js'`.
- The `email export` and `email dev` CLIs run with TS 7 installed. They bundle with esbuild/jiti and do not load the TypeScript API. In the test, the preview server returned 200 and rendered the template. None of these packages needs TS 6 or 5. If TS 7 ever regresses, fall back to `typescript@6.0.3` (the version Resend builds with) or `@typescript/typescript6` (`tsc6`), per https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/.
- TS 7 default changes that matter here: `types` now defaults to `[]`, so keep `"types": ["node"]` explicit. `esModuleInterop` cannot be `false`. `moduleResolution: node10` and `baseUrl` are errors (same source).

## Verified APIs

### A1. Resend: send with an idempotency key

```ts
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const { data, error, headers } = await resend.emails.send(
  {
    from: 'Symplist <reminders@symplist.tejassuds.com>',
    to: [to],
    subject: 'Reminder: Ship the beta',
    html,                 // from React Email render()
    text,                 // from toPlainText(); if omitted Resend derives text from html ('' opts out)
    tags: [{ name: 'category', value: 'reminder' }],
  },
  { idempotencyKey: `reminder/${reminderId}/${occurrenceIso}` },
);
if (error) {
  // error: { name: RESEND_ERROR_CODE_KEY; message: string; statusCode: number | null }
  // e.g. 'rate_limit_exceeded', 'invalid_idempotent_request', 'concurrent_idempotent_requests'
}
```
Sources: https://resend.com/docs/dashboard/emails/idempotency-keys.md and https://resend.com/docs/api-reference/emails/send-email.md
- The SDK option is `idempotencyKey`. It is sent as the `Idempotency-Key` header, and SMTP uses `Resend-Idempotency-Key` instead. Keys can be 1–256 characters. They are **kept for 24 hours**. The docs suggest the format `<event-type>/<entity-id>`.
- Error responses: `400 invalid_idempotency_key` (bad length), `409 invalid_idempotent_request` (same key, different payload; retrying will not help), and `409 concurrent_idempotent_requests` (same key still in flight; safe to retry later).
- `text` is optional. The docs say: "If not provided, the HTML will be used to generate a plain text version. You can opt out of this behavior by setting value to an empty string."
- Tag `name` and `value` may only contain ASCII letters, numbers, `_` and `-`, up to 256 characters each.
- From the published types in `dist/index.d.mts`: every call returns `{ data, error, headers }` and does not throw on API errors. There is no built-in retry, so retries belong to Trigger.dev or our own code.

### A2. Resend: batch send

```ts
const { data, error } = await resend.batch.send(
  [
    { from: 'Symplist <hello@symplist.tejassuds.com>', to: ['a@example.com'], subject: 'You are in', html, text },
    { from: 'Symplist <hello@symplist.tejassuds.com>', to: ['b@example.com'], subject: 'You are in', html, text },
  ],
  { idempotencyKey: `beta-invites/${waveId}` },
);
// data?.data -> [{ id }, ...] in the same order as the input
```
Sources: https://resend.com/docs/dashboard/emails/batch-sending.md and https://resend.com/docs/api-reference/emails/send-batch-emails.md
- A batch holds at most 100 emails. `attachments` are not supported, and batch `scheduled_at` is documented. By default the whole request fails if any email in it is invalid.
- For batches, use one key that represents the whole batch.
- The SDK types (not the docs) also expose `batchValidation?: 'strict' | 'permissive'`, which returns `errors[{ index, ... }]` in permissive mode. It is undocumented, so do not rely on it.

### A3. Resend: webhooks (event types and verification)

Event types (https://resend.com/docs/webhooks/event-types.md, which matches the `WebhookEvent` union in the SDK types):
- Email events: `email.sent`, `email.scheduled`, `email.delivered`, `email.delivery_delayed`, `email.complained`, `email.bounced`, `email.opened`, `email.clicked`, `email.received`, `email.failed`, `email.suppressed`.
- Other events: `domain.created|updated|deleted`, `contact.created|updated|deleted`, `suppression.added|removed`.

Payload shape (https://resend.com/docs/webhooks/introduction.md): `{ type, created_at, data: { email_id, from, to[], subject, tags, ..., bounce?: { type, subType, message } } }`.

Verification: use the SDK. No `svix` install is needed.
```ts
import { Controller, Headers, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Resend, type WebhookEventPayload } from 'resend';

// main.ts: NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true })
@Controller('webhooks/resend')
export class ResendWebhookController {
  private readonly resend = new Resend(process.env.RESEND_API_KEY);

  @Post()
  handle(@Req() req: RawBodyRequest<Request>, @Headers() h: Record<string, string | undefined>) {
    const event: WebhookEventPayload = this.resend.webhooks.verify({
      payload: req.rawBody!.toString('utf8'),          // raw body, never re-stringified JSON
      headers: { id: h['svix-id'] ?? '', timestamp: h['svix-timestamp'] ?? '', signature: h['svix-signature'] ?? '' },
      webhookSecret: process.env.RESEND_WEBHOOK_SECRET!, // whsec_...
    }); // throws on bad signature or stale timestamp
    // dedupe on h['svix-id'], then switch (event.type) { case 'email.bounced': event.data.bounce.type ... }
  }
}
```
Sources:
- https://resend.com/docs/webhooks/verify-webhooks-requests.md: `resend.webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret })`, and it needs the raw body.
- https://docs.nestjs.com/faq/raw-body: `rawBody: true` and `RawBodyRequest`.

Delivery behavior:
- Signature: in `resend@6.28.0`, `verify()` maps the three values onto `webhook-id/-timestamp/-signature` for `standardwebhooks`. The experiment showed a valid signature passes, a one-byte change fails with "No matching signature found", and a 10-minute-old signature fails with "Message timestamp too old".
- Delivery: it is at-least-once, so dedupe on the `svix-id` header. Order is not guaranteed, so sort by `created_at`. Source: https://resend.com/docs/webhooks/introduction.md.
- Retries: immediately, then 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h. Resend emails the team when an endpoint is failing and eventually disables it. Manual replay is available. Source: https://resend.com/docs/webhooks/retries-and-replays.md.
- Source IPs: `44.228.126.217`, `50.112.21.217`, `52.24.126.164`, `54.148.139.208`, `2600:1f24:64:8000::/52`. Source: https://resend.com/docs/webhooks/introduction.md.
- Managing webhooks through the API: the SDK has `resend.webhooks.create/get/list/update/remove/rotateSigningSecret`.

### A4. Resend: domain verification basics

Source: https://resend.com/docs/add-a-domain.md, https://resend.com/docs/dashboard/domains/introduction.md, https://resend.com/docs/dashboard/domains/regions.md, https://resend.com/docs/dashboard/domains/tracking.md
- Send from a subdomain. The domain you enter is the sending domain, and the Return-Path defaults to `send.<domain>`. Choose the region when adding the domain; it can only be changed by deleting and re-adding.
- Add the DKIM and SPF records Resend generates (`TXT`, plus `MX` or `CNAME`) exactly as given. Do not proxy CNAMEs; Cloudflare's orange cloud blocks verification. Verification usually takes about 15 minutes and can take up to 72 hours. Add DMARC after verification.
- Regions are `us-east-1`, `eu-west-1`, `sa-east-1` and `ap-northeast-1`. Region controls only where mail is sent from. Account data, logs and metadata stay in the US.
- Open and click tracking is off by default. Resend recommends keeping it off for transactional mail.

### A5. Resend: rate limits and quotas

Source: https://resend.com/docs/api-reference/rate-limit.md and https://resend.com/docs/knowledge-base/account-quotas-and-limits.md
- The default limit is **10 requests per second per team**, shared across all API keys. It can be raised on request. Response headers are `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset` and `retry-after`, and going over returns `429`.
- Quota errors return `429` with `daily_quota_exceeded` or `monthly_quota_exceeded`. The free plan allows 100/day (UTC day) and 3,000/month. Each To/CC/BCC recipient counts as one email, and received emails count too. Paid plans have no daily quota, and overage is capped at 5x the monthly quota.

### B1. React Email: template, HTML and plain text

```tsx
import { Body, Button, Container, Head, Html, Preview, Section, Text, render, toPlainText } from 'react-email';

export function ReminderEmail({ title, url }: { readonly title: string; readonly url: string }) {
  return (
    <Html lang="en">
      <Head />
      <Body style={{ backgroundColor: '#ffffff', color: '#111111', fontFamily: 'Arial, sans-serif' }}>
        <Preview>{`Reminder: ${title}`}</Preview>
        <Container style={{ backgroundColor: '#ffffff', padding: '24px' }}>
          <Text style={{ color: '#111111', fontSize: '16px' }}>{title}</Text>
          <Button href={url} style={{ backgroundColor: '#1d4ed8', color: '#ffffff', padding: '12px 20px', boxSizing: 'border-box' }}>
            Open task
          </Button>
          <Section data-skip-in-text="true">
            <Text style={{ color: '#444444', fontSize: '12px' }}>HTML-only footer</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export async function renderReminder(props: { title: string; url: string }) {
  const html = await render(<ReminderEmail {...props} />);   // async
  const text = toPlainText(html);                              // sync; or render(el, { plainText: true })
  return { html, text };
}
```
Source: https://react.email/docs/utilities/render.md (`render`, `pretty`, `toPlainText` and `data-skip-in-text`, all imported from `react-email`). The `plainText` and `htmlToTextOptions` options and the signature `render(node, options?) => Promise<string>` come from `@react-email/render@2.1.0` types. Both ESM `import` and CJS `require('react-email')` work on Node 24, which was checked for NestJS.
- Tailwind: use `<Tailwind config={{ presets: [pixelBasedPreset] }}>`, because email clients mishandle `rem`. Known limits: no context providers inside `<Tailwind>`, no `prose`, no `space-*`, and media-query variants cannot be inlined. Source: https://react.email/docs/components/tailwind.md.
- Preview: `email dev --dir emails` (needs `@react-email/ui` as a dev dependency). Static export: `email export --dir emails --outDir out`. Templates export a default component and can set `Component.PreviewProps`. Source: https://react.email/docs/getting-started/manual-setup.
- Observed: adding `--plainText` to `email export` wrote only `.txt` files, not HTML plus text.

### B2. Dark-mode-safe practices (sourced guidance only)

- Resend's accessibility guidance says some inboxes force dark mode by recomputing your colors. It recommends at least **4.5:1 contrast**, because that "increases the likelihood that email-client-enforced dark mode colors are still accessible", and it says to preview in dark mode. Source: https://resend.com/blog/6-tips-for-accessible-emails.
- The React Email maintainers' agent guide says: "Never use theme selectors (`dark:`, `light:`) — not supported". It also says to avoid responsive media-query variants, to never use flexbox/grid, SVG or WEBP, to always set border style, and to use `box-border` on `Button`. Source: https://raw.githubusercontent.com/resend/react-email/main/skills/react-email/SKILL.md.
- Note: react-email 6.9.1 fixed `<Tailwind>` dropping `dark:` variants (package CHANGELOG), but `@media (prefers-color-scheme)` support varies by client. So we will not rely on it.
- Practice for Symplist:
  - One light design with explicit solid `backgroundColor` and `color` on `Body`, `Container` and buttons.
  - Accent colors checked against both white and the inverted dark background.
  - Logos as PNG with a solid or padded background, never transparent dark-on-transparent art.
  - No meaning carried by color alone.
  - Always send `text`.

### C1. PostHog web: locked-down init (US cloud, nothing automatic)

```ts
import posthog, { type CaptureResult, type PostHogConfig } from 'posthog-js'; // default import needs moduleResolution: bundler

const STRIP_EXACT = new Set<string>([
  '$current_url', '$host', '$pathname', '$referrer', '$referring_domain', '$search_engine',
  '$raw_user_agent', '$screen_height', '$screen_width', '$viewport_height', '$viewport_width',
]);
const STRIP_PREFIXES = ['$session_entry_', '$initial_', '$prev_pageview_', 'utm_'] as const;
const CLICK_IDS = new Set<string>(['gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'twclid',
  'li_fat_id', 'igshid', 'ttclid', 'rdt_cid', 'epik', 'qclid', 'sccid', 'irclid', '_kx', 'gad_source', 'mc_cid']);
const isStripped = (k: string) => STRIP_EXACT.has(k) || CLICK_IDS.has(k) || STRIP_PREFIXES.some((p) => k.startsWith(p));
const ALLOWED_EVENTS = new Set<string>(['task_created', 'chat_message_sent', '$identify']); // explicit allowlist

function scrub(bag: Record<string, unknown> | undefined) {
  if (bag) for (const k of Object.keys(bag)) if (isStripped(k)) delete bag[k];
}
function beforeSend(event: CaptureResult | null): CaptureResult | null {
  if (!event || !ALLOWED_EVENTS.has(event.event)) return null; // drop anything not allowlisted
  scrub(event.properties); scrub(event.$set); scrub(event.$set_once);
  return event;
}

export const posthogConfig: Partial<PostHogConfig> = {
  api_host: 'https://us.i.posthog.com',
  ui_host: 'https://us.posthog.com',
  defaults: '2026-08-30',
  opt_out_capturing_by_default: true,
  opt_out_persistence_by_default: true,
  persistence: 'localStorage',          // only used after consent; see C2
  person_profiles: 'identified_only',
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  capture_dead_clicks: false,
  capture_exceptions: false,
  capture_heatmaps: false,
  capture_performance: false,           // disables web vitals and network timing
  rageclick: false,
  disable_session_recording: true,
  disable_surveys: true,
  disable_product_tours: true,
  disable_conversations: true,
  disable_web_experiments: true,
  disable_external_dependency_loading: true,
  advanced_disable_flags: true,         // no /flags request: no feature flags, no remote config
  save_referrer: false,
  save_campaign_params: false,
  mask_personal_data_properties: true,
  property_denylist: [...STRIP_EXACT],
  before_send: beforeSend,
};
```
Sources:
- https://posthog.com/docs/libraries/js/config.md (`api_host`, `ui_host`, `autocapture`, `capture_pageview`, `capture_pageleave`, `capture_dead_clicks`, `capture_exceptions`, `capture_heatmaps`, `capture_performance`, `disable_session_recording`, `disable_surveys`, `advanced_disable_flags`, `opt_out_*`, `persistence`, `cookieless_mode`, `person_profiles`, `property_denylist`, `rageclick`, `defaults`).
- https://posthog.com/docs/references/posthog-js/types/PostHogConfig.md (`disable_product_tours`, `disable_conversations`, `disable_web_experiments`, `disable_external_dependency_loading`, `save_referrer`, `save_campaign_params`, `mask_personal_data_properties`, and `opt_out_capturing_persistence_type: 'localStorage' | 'cookie'`).
- https://posthog.com/docs/libraries/js/usage.md#amending-or-sampling-events (`before_send`, including an array of functions).

Notes on these options:
- `capture_exceptions`, `capture_heatmaps` and `capture_performance` default to `undefined`, which means "use remote config". Setting them to `false` explicitly is what makes them independent of project settings.
- `advanced_disable_flags: true` turns off autocapture, session recording, feature flags, surveys and the toolbar, all of which depend on `/flags` (config doc, "Disable /flags endpoint").
- `defaults` snapshots available in 1.433.4 are `'2025-05-24' | '2025-11-30' | '2026-01-30' | '2026-05-30' | '2026-06-25' | '2026-08-29' | '2026-08-30'`.

Observed in jsdom with this config (url `.../tasks/123?email=a%40b.com`, referrer google):
- Before any consent call: **no localStorage, sessionStorage or cookies, no network requests and no injected scripts**. `capture()` is dropped.
- `before_send` is needed even with `save_referrer: false`. After opt-in, the `$identify` event still carried `$set_once: { $current_url, $referrer, $referring_domain, $host, $pathname, $search_engine, utm_*: null, gclid: null, ... }`, and every event carried `$session_entry_url/_referrer/_pathname/_host/_referring_domain/_search_engine`. The scrubber above removed all of them. `mask_personal_data_properties` did not mask the `email` query parameter; that needs `custom_personal_data_properties: ['email']`.
- Properties that remain after scrubbing: `$browser`, `$browser_version`, `$browser_language`, `$device_type`, `$timezone`, `$timezone_offset`, `$lib*`, `$sdk_debug_*`, `$config_defaults`, `$session_id`, `$window_id`, `$device_id`, `distinct_id`, `$user_id`, `$is_identified`, `$process_person_profile`, `token`, plus our own properties. Add keys to `STRIP_EXACT` if any of these should go too.

### C2. PostHog web: consent (opt-in), persistence, cookieless

```ts
// Consent granted (banner Accept or Settings > Privacy): load lazily, then opt in.
const { default: posthog } = await import('posthog-js');
if (!posthog.__loaded) posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, posthogConfig);
posthog.opt_in_capturing({ captureEventName: false }); // default would send a `$opt_in` event
posthog.identify(user.analyticsId);                     // opaque internal id, never email

// Consent withdrawn:
posthog.opt_out_capturing(); // stops capture; removes ph_* cookie and localStorage persistence
posthog.reset();             // clears identity, persistence and the stored consent key

posthog.has_opted_out_capturing();      // boolean
posthog.has_opted_in_capturing();       // boolean
posthog.get_explicit_consent_status();  // 'granted' | 'denied' | 'pending'
```
Sources:
- https://posthog.com/docs/privacy/data-collection.md (`opt_out_capturing_by_default`, `opt_in_capturing()`, `opt_out_capturing()`, `has_opted_out_capturing()`, the CMP pattern, cookieless tracking).
- https://posthog.com/docs/references/posthog-js.md (`get_explicit_consent_status`, `opt_in_capturing({ captureEventName })`, `reset()` warning).

Consent behavior:
- PostHog stores the consent choice under `__ph_opt_in_out_<token>` in **localStorage** by default (`opt_out_capturing_persistence_type`), even when persistence is `memory`. It is written only when `opt_in_capturing`/`opt_out_capturing` is called.
- Observed on withdrawal: `opt_out_capturing()` removed the `ph_<token>_posthog` cookie and localStorage entry, and `reset()` then removed the consent key. A `ph_<token>_window_id` **sessionStorage** entry was left behind, so remove `ph_*` sessionStorage keys ourselves.
- The PostHog docs advise "Always load posthog-js" and gating capture instead. Our decision is that nothing loads before Accept, which a dynamic import after consent satisfies. The only thing we give up is counting visitors who ignore the banner, which does not apply behind sign-in.

Persistence modes (https://posthog.com/docs/libraries/js/persistence.md):
- `localStorage+cookie` is the default. It uses the `ph_<token>_posthog` cookie with a 365-day expiry.
- The other modes are `cookie`, `localStorage`, `sessionStorage` and `memory` ("only persisted for the duration of the page view").
- `set_config({ persistence })` can switch modes at runtime.
- The SDK warns that `memory` without `bootstrap.distinctID` mints a new distinct ID on every page load, which was observed. Use `localStorage` after consent, or pass `bootstrap: { distinctID }`.
- Observed with `persistence: 'localStorage'` after opt-in: **no cookies at all**. It used localStorage `ph_<token>_posthog` plus sessionStorage `ph_<token>_posthog` and `ph_<token>_window_id`. `opt_out_capturing()` plus `reset()` cleared everything except the sessionStorage `window_id`.

Cookieless mode:
- `cookieless_mode: 'always' | 'on_reject'` stores nothing and hashes identity on PostHog's servers. It also requires "Cookieless server hash mode" to be enabled in project settings, or events are ignored.
- The docs advise against `identify()` in cookieless mode, and `alias()` is dropped.
- It does not fit Symplist, because we identify signed-in users. Sources: https://posthog.com/docs/privacy/data-collection.md#cookieless-tracking and the config doc.

### C3. PostHog web: person profiles and logout

```ts
// logout
posthog.reset();          // new anonymous distinct_id, clears super props, flags cache AND consent
// do NOT call opt_in_capturing() here; the next user's own consent is applied after their sign-in
```
Sources: https://posthog.com/docs/libraries/js/usage.md#resetting-a-user ("We recommend you call `reset` on logout") and https://posthog.com/docs/references/posthog-js.md#reset ("because consent is cleared, `reset()` returns the instance to the default consent state ... Always `reset()` first, then opt in").
- Observed: after `reset()` the status is `pending` and capture is off, and the SDK prints a console warning.
- `person_profiles` can be `'always' | 'never' | 'identified_only'`, and the default is `identified_only`. With the default, only `identify`/`alias`/`group`/`setPersonProperties` create a person. Anonymous events "can be up to 4x cheaper". Source: https://posthog.com/docs/libraries/js/usage.md#capturing-anonymous-events.

### C4. US hosts

- Ingestion (public endpoints) and `api_host`: `https://us.i.posthog.com`. App, UI and private REST API: `https://us.posthog.com`. Source: https://posthog.com/docs/api.md.
- Static assets: `https://us-assets.i.posthog.com` (not loaded with `disable_external_dependency_loading`). Source: https://posthog.com/docs/libraries/js/config.md.
- Content Security Policy if we ever allow PostHog scripts: `connect-src https://*.posthog.com`. Source: https://posthog.com/docs/libraries/next-js.md.

### D1. PostHog server: posthog-node capture, flush, shutdown

```ts
import { PostHog } from 'posthog-node';

export const posthogServer = new PostHog(process.env.POSTHOG_PROJECT_KEY!, {
  host: 'https://us.i.posthog.com',
  disableGeoip: true,                 // default true since v3; explicit for clarity
  personProfiles: 'identified_only',
  enableExceptionAutocapture: false,
  before_send: (event) => (event && SERVER_EVENTS.has(event.event) ? event : null),
});
posthogServer.on('error', (err) => logger.warn({ err }, 'posthog'));

// NestJS (long-running on Render): batched capture, flush on shutdown
posthogServer.capture({ distinctId: user.analyticsId, event: 'task_created', properties: { source: 'mcp' } });
// app.enableShutdownHooks(); in a provider: async onApplicationShutdown() { await posthogServer.shutdown(); }

// Trigger.dev task (short-lived): send before the run ends
await posthogServer.captureImmediate({ distinctId, event: 'reminder_sent' });
await posthogServer.flush();          // per-run cleanup; shutdown() only once per process
```
Sources:
- https://posthog.com/docs/libraries/node.md (constructor `new PostHog(token, { host })`, `capture({ distinctId, event, properties })`, `captureImmediate`, `shutdown()`, `on('error')`, `disableGeoip`, the serverless advice `flushAt: 1` / `flushInterval: 0` or `captureImmediate` + `await shutdown()`).
- https://posthog.com/docs/references/posthog-node.md (`flush()`, and `shutdown(shutdownTimeoutMs?)`, which should be called "once before the process exits ... Use flush() for per-request cleanup instead").
- https://docs.nestjs.com/fundamentals/lifecycle-events (`enableShutdownHooks()` is off by default, plus `onApplicationShutdown(signal)`).

Verified behavior:
- In the experiment with a stub `fetch`, `before_send` dropped a non-allowlisted event. `flush()` posted one batch to `https://us.i.posthog.com/batch/` containing only `$lib`, `$lib_version`, `$is_server` and `$geoip_disable` plus our properties.
- `before_send` and `personProfiles` exist in the `posthog-node@5.52.3` types (`PostHogOptions`, `PostHogCoreOptions`), although the data-collection doc says `before_send` is web-only.
- The docs table lists the `flushInterval` default as 10000 ms, but the types say 5000.

### D2. PostHog: delete a person's data (account deletion)

```ts
const res = await fetch(`https://us.posthog.com/api/projects/${projectId}/persons/bulk_delete/`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.POSTHOG_PERSONAL_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ distinct_ids: [user.analyticsId], delete_events: true, delete_recordings: true }),
});
// 202 -> { persons_found, persons_deleted, events_queued_for_deletion, recordings_queued_for_deletion, deletion_errors }

// status: GET https://us.posthog.com/api/projects/:project_id/persons/deletion_status?status=pending  (person:read)
```
Sources:
- https://posthog.com/docs/open-api-spec/persons_bulk_delete_create.md: `POST /api/projects/{project_id}/persons/bulk_delete/` with security `PersonalAPIKeyAuth: ["person:write"]`. It accepts at most 1000 `ids` or `distinct_ids` per call and has `delete_events`, `delete_recordings` and `keep_person` flags. "Only events captured before the request will be deleted."
- https://posthog.com/docs/open-api-spec/persons_deletion_status_list.md: scope `person:read`.
- https://posthog.com/docs/privacy/data-storage.md#right-to-be-forgotten: needs a personal API key. Event deletion is asynchronous and runs off-peak (weekends on Cloud). Recordings are crypto-shredded. Do not reuse a deleted `distinct_id`.
- The data-storage doc also shows `DELETE /api/projects/<id>/persons/<uuid>?delete_events=true`, but the live OpenAPI schema at https://us.posthog.com/api/schema/ lists only `bulk_delete` for deleting persons. So use `bulk_delete`, which also avoids a lookup from `distinct_id` to person UUID.
- Rate limit for these CRUD endpoints: 480/minute and 4800/hour, shared by the whole organization. Source: https://posthog.com/docs/api.md.
- Required personal API key scopes: `person:write` (delete) and `person:read` (status and lookup). Set the key's project scope to the Symplist project only.

## Decisions and recommendations

1. **Packages to pin exactly:** `resend@6.28.0`, `react-email@6.9.5`, `react@19.3.0`, `react-dom@19.3.0`, `posthog-js@1.433.4` (web) and `posthog-node@5.52.3` (API and worker). Add `@react-email/ui@6.9.5` as a dev dependency for the preview. Do not install `@react-email/components` (deprecated) or `svix`.
2. **Templates live in one shared workspace package** (for example `packages/emails`) imported by NestJS (login codes, Vault reset) and the Trigger.dev worker (reminders). Render with `render()` + `toPlainText()` and pass both `html` and `text` to Resend. Do not use Resend's `react:` option, because it dynamically imports `@react-email/render`, which pnpm's strict layout would not resolve unless declared, and it does not produce `text`.
3. **Idempotency on every send.** Key formats: `login-code/<challengeId>`, `vault-reset/<requestId>`, `reminder/<reminderId>/<occurrenceIso>`. The 24-hour window covers Trigger.dev retries. Treat `409 concurrent_idempotent_requests` as retryable and `409 invalid_idempotent_request` as a bug. Put Trigger.dev queue concurrency or backoff in front of the 10 rps team limit, and honor `retry-after` on 429.
4. **Webhooks in NestJS:**
   - Enable `rawBody: true` and verify with `resend.webhooks.verify` against `RESEND_WEBHOOK_SECRET`.
   - Store processed `svix-id`s in D1 for dedupe and return 2xx fast.
   - Subscribe only to `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed` and `email.delivery_delayed`.
   - On a `Permanent` bounce or a complaint, mark the address undeliverable and stop reminder emails.
   - Keep open and click tracking off.
5. **Domain:** `symplist.tejassuds.com`, already decided. Region `us-east-1`, with DKIM/SPF records set as DNS-only (not proxied) in Cloudflare, then DMARC. Security and reminder mail use separate from-addresses on the same verified domain, as already decided.
6. **Dark mode:** one light, high-contrast design (4.5:1 minimum) with explicit backgrounds and colors on every block. No `dark:` or `prefers-color-scheme` styling. Always include plain text. Check in the `email dev` preview plus real Gmail, Apple Mail and Outlook dark modes before launch.
7. **PostHog web loading:**
   - Do not load `posthog-js` until the account's consent is `granted` (the D1 value synced with Settings > Privacy). Then `import()` it, `init` with the C1 config, `opt_in_capturing({ captureEventName: false })`, and `identify(analyticsId)`.
   - Use `persistence: 'localStorage'`, so there are no cookies; the app runs on one origin.
   - Never load it on the login, Vault or share pages.
   - Keep `opt_out_capturing_by_default: true` as defense in depth, and track events only through a typed `track()` wrapper whose event union matches the `before_send` allowlist.
8. **Identity:** `distinct_id` is an opaque per-user `analyticsId` stored in D1, never the email or the internal primary key if that key appears in URLs. Do not set email or name as person properties. Keep `person_profiles: 'identified_only'`. In the PostHog project settings, turn on "discard client IP data", per https://posthog.com/docs/privacy/data-collection.md#ip-data-capture.
9. **Logout and withdrawal:** logout calls `posthog.reset()` with no re-opt-in. Withdrawal calls `opt_out_capturing()`, then `reset()`, then removes leftover `ph_*` sessionStorage keys. The server must also stop: every server capture checks the user's consent flag in D1 first.
10. **Server analytics:** one `PostHog` client per process.
    - NestJS: batched `capture`, plus `enableShutdownHooks()` and `shutdown()` on application shutdown.
    - Trigger.dev tasks: `captureImmediate` (or `capture` + `flush()`) inside the run.
    - Both: `before_send` allowlist and `disableGeoip: true`.
11. **Account deletion:** a Trigger.dev task calls `POST /api/projects/{id}/persons/bulk_delete/` with `distinct_ids: [analyticsId]`, `delete_events: true` and `delete_recordings: true`, using `POSTHOG_PERSONAL_API_KEY` (scopes `person:write` + `person:read`, limited to one project). It records the 202 response and polls `deletion_status` until `completed`. The `analyticsId` is never reused.
12. **TypeScript 7.0.2 is fine for all of this.** Either keep `skipLibCheck: true` (as `apps/worker` does) or add `@types/html-to-text`, `@types/prismjs`, `@types/css-tree` and `@types/express` as dev deps. Import `posthog-js` as a default only under `moduleResolution: bundler` (Next.js); under `nodenext`, use `import { posthog } from 'posthog-js'`.

## Risks and open questions

- **The PostHog SDKs release almost daily.** Config defaults change with `defaults` snapshots. Pin exact versions, pin `defaults: '2026-08-30'`, and re-run the jsdom payload check (no URL, referrer or UTM properties; no storage before consent) whenever posthog-js is upgraded.
- **The scrubber is a denylist on top of an event allowlist.** A future posthog-js release could add new URL-bearing properties (as `$session_entry_*` once was). Mitigation: a CI test that inits the SDK in jsdom and asserts that no property value contains the page URL or referrer.
- **The docs and types disagree in places:**
  - `opt_out_capturing_persistence_type` values: the docs say `local_storage`/`cookies`, the types say `'localStorage' | 'cookie'`.
  - The `posthog-node` `flushInterval` default: 10000 in the docs, 5000 in the types.
  - `before_send` is documented as web-only but exists in posthog-node.
  - The persons `DELETE /persons/<uuid>` endpoint is in the docs but not in the OpenAPI schema.
  - In every case we follow the published types and the live schema.
- **`reset()` clears PostHog's stored consent.** Any code path that calls `reset()` after opting in silently stops capture. Keep D1 as the source of truth and re-apply consent only after sign-in.
- **The consent key persists after a choice.** `__ph_opt_in_out_<token>` stays in localStorage once the user makes an explicit choice, and `ph_<token>_window_id` stays in sessionStorage after withdrawal. Confirm the privacy notice covers the consent record, and clear the sessionStorage entry ourselves.
- **Resend `batchValidation: 'permissive'` is in the SDK types but not in the docs.** Do not rely on it.
- **The Resend SDK has no retries or backoff.** A burst of reminders can hit 429 at 10 rps. Trigger.dev queue limits are needed, which the worker research should confirm.
- **Resend account data is stored in the US whatever the sending region.** Disclose it in PRIVACY.md next to PostHog US.
- **`@react-email/ui` pulls in `next 16.3.3` as a dev dependency.** It may conflict with or duplicate the frontend's Next.js version in the pnpm store. Keep it scoped to the emails package.
- **Open question: exact Gmail, Outlook and Apple Mail dark-mode rendering of our accent colors.** It is not covered by official docs and needs manual checks on real clients before launch.
- **Open question: whether PostHog's project-level "discard client IP data" is applied before storage for US Cloud projects created before the setting existed.** Check it in the project settings when the project is created.
