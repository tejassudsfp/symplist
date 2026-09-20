import { expect, type Page, test } from "@playwright/test";
import {
  documentPublishResponseSchema,
  preferenceEntrySchemas,
  preferencesPutResponseSchema,
  searchFreshnessResponseSchema,
  simonConversationCreatedSchema,
  simonMessageAcceptedSchema,
  simonRunViewSchema,
  taskCompleteResponseSchema,
  taskCreateResponseSchema,
} from "@symplist/contracts";
import { type OwnerApi, ownerApi } from "../src/helpers/phase-e.ts";
import { signIn } from "../src/helpers/session.ts";

const query = "cairn";
const nowTitle = "Cairn launch checklist";
const laterTitle = "Cairn follow-up for later";
const archivedTitle = "Cairn retired outline";
const documentHeading = "Cairn field evidence";
const documentMarker = "Indexed only through the production document source.";
const chatMarker = "Keep the cairn conversation marker with this task.";

async function createTask(api: OwnerApi, title: string, collection: "now" | "later") {
  const response = await api.post("/tasks", { title, collection });
  expect(response.status(), await response.text()).toBe(201);
  return taskCreateResponseSchema.parse(await response.json()).task;
}

async function showFilters(page: Page) {
  const filters = page.getByRole("region", { name: "Search filters" });
  if (!(await filters.isVisible())) {
    await page.getByRole("button", { name: "Filters", exact: true }).click();
  }
  await expect(filters).toBeVisible();
  return filters;
}

/**
 * Phase E's production-registry proof. Unlike search.spec.ts (decision S16), this journey intercepts
 * no route: source writes, the local-mode index rebuild, encrypted object publication, API query and
 * browser rendering all use the production seams.
 */
test("the production index searches tasks, current pages, opted-in chat and the archive", async ({
  context,
  page,
}) => {
  await signIn(context);
  const api = await ownerApi(context);

  const active = await createTask(api, nowTitle, "now");
  await createTask(api, laterTitle, "later");
  const archived = await createTask(api, archivedTitle, "now");

  const published = await api.post(`/tasks/${active.id}/document/commits`, {
    baseRevision: null,
    markdown: `## ${documentHeading}\n\n${documentMarker}\n`,
  });
  expect(published.status(), await published.text()).toBe(201);
  documentPublishResponseSchema.parse(await published.json());

  const conversationResponse = await api.post("/conversations", {
    kind: "task",
    taskId: active.id,
  });
  expect(conversationResponse.status(), await conversationResponse.text()).toBe(201);
  const { conversationId } = simonConversationCreatedSchema.parse(
    await conversationResponse.json(),
  );
  const messageResponse = await api.post(`/conversations/${conversationId}/messages`, {
    text: chatMarker,
    tier: "fast",
  });
  expect(messageResponse.status(), await messageResponse.text()).toBe(202);
  const accepted = simonMessageAcceptedSchema.parse(await messageResponse.json());
  expect(accepted.runId).not.toBeNull();
  await expect
    .poll(
      async () => {
        const response = await api.get(`/runs/${accepted.runId}`);
        if (!response.ok()) return `http-${response.status()}`;
        return simonRunViewSchema.parse(await response.json()).status;
      },
      {
        message: "the scripted local turn should finish before the index snapshot",
        timeout: 15_000,
      },
    )
    .toBe("completed");

  const completed = await api.post(`/tasks/${archived.id}/complete`, {
    mode: "all",
    stopRun: false,
  });
  expect(completed.status(), await completed.text()).toBe(200);
  expect(taskCompleteResponseSchema.parse(await completed.json()).archivedTaskIds).toContain(
    archived.id,
  );

  // Chat stays out until the owner explicitly opts in. Saving this preference asks the real local
  // coordinator for an immediate rebuild, replacing the producers' ordinary 30-second delay.
  const privacyResponse = await api.get("/preferences/privacy");
  expect(privacyResponse.status(), await privacyResponse.text()).toBe(200);
  const privacy = preferenceEntrySchemas.privacy.parse(await privacyResponse.json());
  const optedInResponse = await api.put("/preferences/privacy", {
    baseVersion: privacy.version,
    clientSeq: 1,
    data: { includeChatInSearch: true },
  });
  expect(optedInResponse.status(), await optedInResponse.text()).toBe(200);
  expect(preferencesPutResponseSchema.parse(await optedInResponse.json())).toMatchObject({
    group: "privacy",
    data: { includeChatInSearch: true },
  });

  // The first read also requests a rebuild if publication has not started yet. Reaching ready:0
  // proves the production writer published and consumed every source intent before the UI query.
  await expect
    .poll(
      async () => {
        const response = await api.get("/search/freshness");
        if (!response.ok()) return `http-${response.status()}`;
        const freshness = searchFreshnessResponseSchema.parse(await response.json());
        return `${freshness.status}:${freshness.pendingIntents}`;
      },
      { message: "the production local search index should publish", timeout: 30_000 },
    )
    .toBe("ready:0");

  await page.goto("/search");
  const searchbox = page.getByRole("searchbox", {
    name: "Search tasks, documents and chat",
  });
  await expect(searchbox).toBeFocused();
  await searchbox.fill(query);

  const activeResult = page.getByRole("article").filter({ hasText: nowTitle });
  const laterResult = page.getByRole("article").filter({ hasText: laterTitle });
  const archivedResult = page.getByRole("article").filter({ hasText: archivedTitle });
  await expect(activeResult).toBeVisible();
  await expect(laterResult).toBeVisible();
  await expect(archivedResult).toHaveCount(0);
  await expect(activeResult.locator('[data-slot="section-hit"]')).toContainText(documentMarker);
  await expect(activeResult.locator('[data-slot="message-hit"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="scope"]')).toContainText(
    "Task titles and documents in Now, Later and Unclassified. Archived tasks aren't included.",
  );

  const filters = await showFilters(page);
  await filters.getByRole("checkbox", { name: "Later", exact: true }).uncheck();
  await expect(laterResult).toHaveCount(0);
  await expect(activeResult).toBeVisible();
  await expect(page.locator('[data-slot="scope"]')).toContainText(
    "Task titles and documents in Now and Unclassified.",
  );

  await filters.getByRole("checkbox", { name: "Chat", exact: true }).check();
  await expect(activeResult.locator('[data-slot="message-hit"]')).toContainText(chatMarker);
  await expect(page.locator('[data-slot="scope"]')).toContainText(
    "Task titles, documents and chat in Now and Unclassified.",
  );

  await filters.getByRole("radio", { name: "Active and archived", exact: true }).check();
  await expect(archivedResult).toBeVisible();
  await expect(archivedResult.getByText("Archived", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="scope"]')).toContainText("Archived tasks are included.");

  // Opening a real document hit re-authorizes the task and carries only its opaque section id.
  await activeResult.locator('[data-slot="section-hit"]').click();
  await expect(page).toHaveURL(new RegExp(`/now/${active.id}\\?section=s[A-Za-z0-9_-]{25}$`));
});
