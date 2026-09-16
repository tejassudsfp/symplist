import type {
  SearchFreshness,
  SearchMessageHit,
  SearchResponse,
  SearchResultGroup,
  SearchSectionHit,
  SearchTaskSummary,
  SearchTitleResponse,
  SearchTitleResult,
} from "@symplist/contracts";
import {
  conversationIdSchema,
  messageIdSchema,
  taskIdSchema,
  userIdSchema,
} from "@symplist/contracts";
import { fixtureId, mayaTask, mayaTasks, mayaUser } from "@symplist/testing";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ActionsProvider } from "@/actions/provider";
import type { ActionServices, AppAction } from "@/actions/types";
import { StatusAnnouncerProvider } from "@/components/ui/status-announcer";
import { type Session, SessionProvider } from "@/features/access/session";
import type { SearchApi } from "./api.ts";
import { SearchApiProvider } from "./client.tsx";

/*
 * Shared fixtures and a render helper for the search surfaces' tests. Content comes from the Maya
 * dataset (`@symplist/testing`), so every screen, api test and e2e flow shows the same fictional
 * account.
 */

export const mayaSession: Session = {
  status: "signed_in",
  user: {
    id: userIdSchema.parse(mayaUser.id),
    displayName: mayaUser.displayName,
    email: mayaUser.email,
    role: mayaUser.role,
  },
  access: {
    emailVerifiedAt: mayaUser.emailVerifiedAt,
    betaState: "unlocked",
    suspendedAt: null,
    onboardingStep: "done",
    role: "member",
    accessGeneration: 3,
    accessEpoch: 1,
    deletionState: "none",
  },
};

export const lockedSession: Session = {
  ...mayaSession,
  access: { ...(mayaSession.access as NonNullable<Session["access"]>), betaState: "locked" },
};

export const signedOutSession: Session = { status: "signed_out" };

export function taskSummary(
  title: string,
  overrides: Partial<SearchTaskSummary> = {},
): SearchTaskSummary {
  const fixture = mayaTask(title);
  const parentFixture = fixture.parentId
    ? mayaTasks.find((task) => task.id === fixture.parentId)
    : undefined;
  return {
    id: taskIdSchema.parse(fixture.id),
    title: fixture.title,
    titleHighlights: [],
    collection: fixture.collection,
    archived: fixture.status === "archived",
    parent: parentFixture
      ? { id: taskIdSchema.parse(parentFixture.id), title: parentFixture.title }
      : null,
    updatedAt: fixture.updatedAt,
    ...overrides,
  };
}

export function titleResult(
  title: string,
  overrides: Partial<SearchTitleResult> = {},
): SearchTitleResult {
  return { task: taskSummary(title), match: "title_prefix", titleStale: false, ...overrides };
}

export function titleResponse(
  items: readonly SearchTitleResult[],
  freshness: Partial<SearchFreshness> = {},
): SearchTitleResponse {
  return {
    status: "ready",
    indexGeneration: 7,
    pendingIntents: 0,
    ...freshness,
    items: [...items],
  };
}

export function sectionHit(overrides: Partial<SearchSectionHit> = {}): SearchSectionHit {
  return {
    sectionId: "sec-projects-to-feature",
    ordinal: 2,
    heading: "Projects to feature",
    headingHighlights: [],
    match: "body",
    snippet: {
      text: "Field notes app — the one people actually ask about",
      highlights: [{ start: 0, end: 5 }],
      truncatedStart: false,
      truncatedEnd: true,
    },
    indexedRevision: "rev-12",
    currentRevision: "rev-12",
    stale: false,
    ...overrides,
  };
}

export function messageHit(overrides: Partial<SearchMessageHit> = {}): SearchMessageHit {
  return {
    messageId: messageIdSchema.parse(fixtureId(0x5a1)),
    conversationId: conversationIdSchema.parse(fixtureId(0x5b1)),
    speaker: "simon",
    createdAt: 1_756_724_400_000,
    snippet: {
      text: "Tightened the Projects section: one framing sentence.",
      highlights: [{ start: 10, end: 18 }],
      truncatedStart: false,
      truncatedEnd: false,
    },
    ...overrides,
  };
}

export function resultGroup(
  title: string,
  overrides: Partial<SearchResultGroup> = {},
): SearchResultGroup {
  return {
    task: taskSummary(title),
    match: "body",
    matchedAllTerms: true,
    titleStale: false,
    sections: [],
    sectionCount: 0,
    messages: [],
    messageCount: 0,
    ...overrides,
  };
}

export function searchResponse(
  items: readonly SearchResultGroup[],
  overrides: Partial<SearchResponse> = {},
): SearchResponse {
  return {
    status: "ready",
    indexGeneration: 7,
    pendingIntents: 0,
    scope: {
      collections: ["now", "later", "unclassified"],
      archive: "exclude",
      types: ["tasks", "documents"],
      taskId: null,
      deadline: null,
    },
    notices: [],
    items: [...items],
    nextCursor: null,
    ...overrides,
  };
}

/** A search API whose calls a test fills in; anything it leaves out rejects loudly. */
export function stubSearchApi(overrides: Partial<SearchApi>): SearchApi {
  const missing = (name: string) => () => Promise.reject(new Error(`${name} was not stubbed`));
  return {
    titles: missing("titles"),
    content: missing("content"),
    freshness: missing("freshness"),
    recentTasks: missing("recentTasks"),
    locateTask: missing("locateTask"),
    ...overrides,
  };
}

export interface RenderSearchOptions {
  readonly api: SearchApi;
  readonly session?: Session;
  readonly actions?: readonly AppAction[];
  readonly services?: Partial<ActionServices>;
}

/** Renders a search surface inside the providers the app gives it. */
export function renderSearch(ui: ReactNode, options: RenderSearchOptions): RenderResult {
  const services: ActionServices = {
    navigate: () => undefined,
    assign: () => undefined,
    announce: () => undefined,
    route: null,
    shell: null,
    ...options.services,
  };
  return render(
    <StatusAnnouncerProvider>
      <SessionProvider value={options.session ?? mayaSession}>
        <ActionsProvider actions={options.actions ?? []} services={services}>
          <SearchApiProvider api={options.api}>{ui}</SearchApiProvider>
        </ActionsProvider>
      </SessionProvider>
    </StatusAnnouncerProvider>,
  );
}
