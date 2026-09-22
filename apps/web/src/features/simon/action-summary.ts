/**
 * Plain-language readings of a proposed connector action. An owner approves an intent, not a JSON
 * payload, so the approval card leads with one sentence and keeps the exact fields a disclosure
 * away. Every phrase is built from facts the arguments already carry: nothing is inferred about a
 * value, and a structured value — a vault handle above all — is counted, never read.
 */

interface Service {
  readonly name: string;
  /** Word that makes a generic object concrete: a Google Calendar "event" is a calendar event. */
  readonly noun?: string;
}
/** An approval carries a toolkit slug only; the provider catalogue is not loaded in the chat pane. */
const services = new Map<string, Service>([
  ["airtable", { name: "Airtable" }],
  ["asana", { name: "Asana" }],
  ["discord", { name: "Discord", noun: "Discord" }],
  ["dropbox", { name: "Dropbox" }],
  ["github", { name: "GitHub", noun: "GitHub" }],
  ["gitlab", { name: "GitLab", noun: "GitLab" }],
  ["gmail", { name: "Gmail", noun: "email" }],
  ["googlecalendar", { name: "Google Calendar", noun: "calendar" }],
  ["googledocs", { name: "Google Docs", noun: "document" }],
  ["googledrive", { name: "Google Drive", noun: "Drive" }],
  ["googlesheets", { name: "Google Sheets", noun: "spreadsheet" }],
  ["googletasks", { name: "Google Tasks" }],
  ["hackernews", { name: "Hacker News" }],
  ["hubspot", { name: "HubSpot" }],
  ["jira", { name: "Jira", noun: "Jira" }],
  ["linear", { name: "Linear", noun: "Linear" }],
  ["notion", { name: "Notion", noun: "Notion" }],
  ["outlook", { name: "Outlook", noun: "email" }],
  ["perplexityai", { name: "Perplexity AI" }],
  ["salesforce", { name: "Salesforce" }],
  ["slack", { name: "Slack", noun: "Slack" }],
  ["todoist", { name: "Todoist" }],
  ["trello", { name: "Trello", noun: "Trello" }],
  ["zoom", { name: "Zoom", noun: "Zoom" }],
]);
const searchVerbs = new Set(["browse", "fetch", "find", "list", "lookup", "query", "search"]);
const readVerbs = new Set(["describe", "download", "export", "get", "read", "retrieve", "view"]);
const writeVerbs = new Map<string, string>([
  ["add", "Add"],
  ["archive", "Archive"],
  ["assign", "Assign"],
  ["cancel", "Cancel"],
  ["comment", "Comment on"],
  ["copy", "Copy"],
  ["create", "Create"],
  ["delete", "Delete"],
  ["forward", "Forward"],
  ["invite", "Invite"],
  ["label", "Label"],
  ["move", "Move"],
  ["post", "Post"],
  ["publish", "Publish"],
  ["reply", "Reply to"],
  ["schedule", "Schedule"],
  ["send", "Send"],
  ["share", "Share"],
  ["update", "Update"],
  ["upload", "Upload"],
]);
/** Slug dialects differ between providers: third-person and near-synonym forms collapse onto one. */
const verbAliases = new Map<string, string>([
  ["adds", "add"],
  ["creates", "create"],
  ["deletes", "delete"],
  ["edit", "update"],
  ["edits", "update"],
  ["fetches", "fetch"],
  ["gets", "get"],
  ["lists", "list"],
  ["modify", "update"],
  ["patch", "update"],
  ["remove", "delete"],
  ["removes", "delete"],
  ["searches", "search"],
  ["sends", "send"],
  ["set", "update"],
  ["shares", "share"],
  ["trash", "delete"],
  ["updates", "update"],
]);
const stopWords = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "the",
  "to",
  "with",
]);
const recipientKeys = [
  "recipient",
  "recipients",
  "recipientemail",
  "recipientemails",
  "recipientaddress",
  "toemail",
  "toemails",
  "sendto",
  "to",
];
const dateKeys = [
  "start",
  "startdate",
  "starttime",
  "startdatetime",
  "startsat",
  "scheduledat",
  "sendat",
  "duedate",
  "dueat",
  "due",
  "deadline",
  "eventdate",
  "eventtime",
  "datetime",
  "date",
  "when",
];
const subjectKeys = ["subject", "title", "name", "summary"];

export interface ApprovalAction {
  readonly toolSlug: string;
  readonly connectionToolkit: string | null;
  readonly arguments: Readonly<Record<string, unknown>>;
}
export interface ActionSummary {
  /** One sentence an owner can decide on: a verb, its object and the facts the arguments carry. */
  readonly headline: string;
  /** The action's own subject or title, quoted, when it has one. */
  readonly subject: string | null;
}

function sentenceCase(value: string): string {
  return value ? `${value[0]?.toLocaleUpperCase()}${value.slice(1)}` : "";
}
function words(value: string): string {
  return (
    sentenceCase(value.replaceAll(/[_-]+/g, " ").trim().toLocaleLowerCase()) || "Connected service"
  );
}
export function serviceLabel(toolkit: string | null): string {
  if (!toolkit) return "Connected service";
  return services.get(toolkit.toLocaleLowerCase())?.name ?? words(toolkit);
}
function actionTokens(toolSlug: string, toolkit: string | null): readonly string[] {
  const prefix = toolkit ? `${toolkit.toLocaleLowerCase()}_` : "";
  const slug = toolSlug.toLocaleLowerCase();
  return (prefix && slug.startsWith(prefix) ? slug.slice(prefix.length) : slug)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
export function actionLabel(toolSlug: string, toolkit: string | null): string {
  return words(actionTokens(toolSlug, toolkit).join(" "));
}
function objectPhrase(
  tokens: readonly string[],
  toolkit: string | null,
  service: Service | undefined,
): string {
  const noun = service?.noun;
  const parts: string[] = [];
  for (const token of tokens) {
    // A preposition ends the object ("send a message to a channel"); a leading one is noise.
    if (stopWords.has(token)) {
      if (parts.length) break;
      continue;
    }
    if (token === toolkit || token === noun?.toLocaleLowerCase()) continue;
    parts.push(token);
  }
  const text = parts.join(" ");
  if (!noun) return text;
  return text ? `${noun} ${text}` : noun;
}
function withArticle(text: string): string {
  const last = text.split(" ").at(-1) ?? "";
  if (last.endsWith("s") && !/(?:ss|us|is)$/.test(last)) return text;
  return `${/^[aeiou]/i.test(text) ? "an" : "a"} ${text}`;
}
function normalizeKey(key: string): string {
  return key.toLocaleLowerCase().replaceAll(/[^a-z0-9]/g, "");
}
function pick(fields: ReadonlyMap<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = fields.get(key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}
/** Only a plain string is ever spoken back. Anything structured stays behind the disclosure. */
function plainText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replaceAll(/\s+/g, " ").trim() || null;
}
function present(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  return typeof value === "object" && value !== null;
}
function recipientPhrase(value: unknown): string | null {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string" && value.includes(",")
      ? value.split(",")
      : [value];
  const items = entries.filter(present);
  if (!items.length) return null;
  const only = items.length === 1 ? plainText(items[0]) : null;
  if (only && only.length <= 60) return `to ${only}`;
  return `to ${items.length} recipient${items.length === 1 ? "" : "s"}`;
}
function datePhrase(value: unknown): string | null {
  const text = plainText(value);
  // A four-digit year keeps loose identifiers out of the date reading.
  if (!text || !/\d{4}/.test(text)) return null;
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const at = Date.parse(dayOnly ? `${text}T00:00:00Z` : text);
  if (!Number.isFinite(at)) return null;
  // A day without a time has no instant, so reading it in the viewer's zone would shift the date.
  const zone = dayOnly ? "UTC" : undefined;
  const when = new Date(at);
  const year = dayOnly ? when.getUTCFullYear() : when.getFullYear();
  const current = dayOnly ? new Date().getUTCFullYear() : new Date().getFullYear();
  const format = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    timeZone: zone,
    ...(year === current ? {} : { year: "numeric" }),
  });
  return `on ${format.format(at)}`;
}
function quoted(value: unknown): string | null {
  const text = plainText(value);
  if (!text) return null;
  return `“${text.length > 120 ? `${text.slice(0, 119)}…` : text}”`;
}
export function actionSummary(action: ApprovalAction): ActionSummary {
  const toolkit = action.connectionToolkit?.toLocaleLowerCase() || null;
  const service = toolkit ? services.get(toolkit) : undefined;
  const name = toolkit ? serviceLabel(toolkit) : null;
  const fields = new Map(
    Object.entries(action.arguments).map(([key, value]) => [normalizeKey(key), value]),
  );
  const subject = quoted(pick(fields, subjectKeys));
  const tokens = actionTokens(action.toolSlug, action.connectionToolkit);
  const [head, ...rest] = tokens;
  const verb = head ? (verbAliases.get(head) ?? head) : "";
  const object = objectPhrase(rest, toolkit, service);
  if (searchVerbs.has(verb))
    return { headline: name ? `Search your ${name}` : "Search the connected service", subject };
  if (readVerbs.has(verb) && object)
    return { headline: `Read ${withArticle(object)}${name ? ` in ${name}` : ""}`, subject };
  const write = writeVerbs.get(verb);
  if (write && object) {
    const facts = [
      recipientPhrase(pick(fields, recipientKeys)),
      datePhrase(pick(fields, dateKeys)),
    ].filter((fact): fact is string => fact !== null);
    return { headline: [`${write} ${withArticle(object)}`, ...facts].join(" "), subject };
  }
  // An unknown verb reads back as the humanised slug rather than as a guess about what it does.
  return {
    headline: sentenceCase(tokens.join(" ")) || (name ? `Use ${name}` : "Run a connected action"),
    subject,
  };
}
