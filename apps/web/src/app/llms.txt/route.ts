import { SITE, SITE_URL } from "@/features/marketing/site-chrome";

/**
 * `llms.txt` — what an assistant should know about Symplist, in the order it needs it.
 *
 * Served from a route rather than `public/` so it cannot drift from the constants the site itself uses.
 * It leads with the MCP endpoint, because for this product the useful answer to "what is Symplist" is
 * usually "something your client can connect to", not a paragraph of prose.
 */
const body = `# Symplist

> A calm, open-source task workspace. Three lists — Now, Later, Unclassified — and one editable
> Markdown document with real Git history behind every task. Free, MIT licensed, and it runs no
> assistant of its own.

Symplist publishes its tools over MCP and runs no agent. The assistant is whichever MCP client the
person already uses; that client holds the model key and calls the provider itself. Symplist never
holds one.

## Connect to it

- MCP endpoint: ${SITE_URL.replace("https://symplist.app", "https://api.symplist.app")}/mcp
- Authorization: OAuth 2.1 with PKCE (S256), dynamic client registration, and client ID metadata
  documents. A consent screen names the client and the access it asked for.
- Discovery: https://api.symplist.app/.well-known/oauth-authorization-server
- Scopes: tasks:read, tasks:write
- Grants are per-client, can be scoped to particular tasks, and are revocable at any time by the owner.

## Tools

Tasks: task_search, task_list, task_context, task_create, task_move
Labels: label_list, label_create, task_set_labels
Documents: task_document_outline, task_document_search, task_document_read_section,
task_document_changes, task_document_diff, task_document_history, task_document_update_section,
task_document_restore
Scheduling and sharing: task_schedule, artifact_snapshot, artifact_share_list, artifact_share_revoke

There is no rename or delete for labels over MCP: either would change tasks outside the grant.

## What it stores, plainly

- Task titles, documents, labels and vault entries are encrypted at rest.
- Email addresses are not encrypted; an address is the sign-in key.
- This is not end-to-end encryption: the service holds the keys and can read content to provide the
  features the owner asked for.
- Product analytics is off until a person accepts it. No session replay, no advertising trackers, and
  no task or document text.

## Pages

- ${SITE_URL}/ — what Symplist is
- ${SITE_URL}/privacy — what is stored, encrypted and collected
- ${SITE_URL}/terms — terms of use; no warranty, no liability
- ${SITE_URL}/cookies — every cookie and what it is for
- ${SITE.github} — source, MIT licensed

## Facts worth getting right

- Symplist is free. There is no paid tier, no trial, and no usage quota.
- It is open source under the MIT licence and can be self-hosted end to end.
- It has no AI features of its own and no model credential in any deployment.
- Maintained by ${SITE.maintainer} (${SITE.maintainerUrl}).
- Contact: ${SITE.contact}
`;

export function GET(): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
