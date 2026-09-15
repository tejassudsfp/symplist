/**
 * The Maya fixture dataset (design/mockups/overall.md "Content and microcopy", the UI sample's
 * workspace_now data, and the Later, Unclassified and Archive briefs). Every screen, API test and
 * e2e flow uses the same fictional account, tasks, documents and conversations. Nothing here is a
 * real person, address or credential.
 */

export type FixtureCollection = "now" | "later" | "unclassified";
export type FixtureTaskStatus = "active" | "archived";
export type FixtureTaskSource = "user" | "simon" | `mcp:${string}`;

/** A UUIDv7-shaped fixture id with a readable sequence number. */
export function fixtureId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff_ffff) {
    throw new RangeError("fixture ids take a sequence number that fits 48 bits");
  }
  return `0192f0a0-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

/** 2026-09-01T09:00:00Z; every fixture timestamp is an offset from it. */
export const fixtureEpoch = Date.UTC(2026, 8, 1, 9, 0, 0);
const hour = 3_600_000;
const at = (hours: number) => fixtureEpoch + hours * hour;

export interface FixtureUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly timeZone: string;
  readonly role: "member" | "admin";
  readonly emailVerifiedAt: number;
  readonly betaState: "locked" | "unlocked" | "relocked";
  readonly onboardingStep: "name" | "connections" | "done";
  readonly analyticsConsent: "unset" | "granted" | "denied";
  /** Random analytics id, unrelated to the user id (decision R9). */
  readonly analyticsId: string;
  readonly createdAt: number;
}

export interface FixtureTask {
  readonly id: string;
  readonly ownerId: string;
  readonly parentId: string | null;
  readonly collection: FixtureCollection;
  /** Fractional index within its parent or collection (§3.4). */
  readonly position: string;
  readonly status: FixtureTaskStatus;
  readonly archivedAt: number | null;
  readonly archivedWithRootId: string | null;
  readonly source: FixtureTaskSource;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface FixtureDocument {
  readonly taskId: string;
  readonly markdown: string;
}

export interface FixtureActivity {
  readonly label: string;
  readonly tool: string;
  readonly status: "running" | "done" | "failed";
  readonly detail: string;
}

export interface FixtureMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly activity: readonly FixtureActivity[];
  readonly approval: {
    readonly status: "pending" | "approved" | "denied";
    readonly toolSlug: string;
  } | null;
  readonly createdAt: number;
}

export interface FixtureConversation {
  readonly id: string;
  readonly kind: "task" | "quick";
  /** Null for quick chats (§8.7). */
  readonly taskId: string | null;
  readonly messages: readonly FixtureMessage[];
}

export const mayaUser: FixtureUser = {
  id: fixtureId(0x1),
  email: "maya@example.com",
  displayName: "Maya Rao",
  timeZone: "America/Los_Angeles",
  role: "member",
  emailVerifiedAt: at(0),
  betaState: "unlocked",
  onboardingStep: "done",
  analyticsConsent: "unset",
  analyticsId: "5b3c9f2e-8d4a-4e71-a0c6-2f9d17e84b35",
  createdAt: at(0),
};

/** The connected agent grant that added "Review the outline" to Unclassified. */
export const mayaMcpGrantId = fixtureId(0x901);

interface TaskSeed {
  readonly id: number;
  readonly title: string;
  readonly collection: FixtureCollection;
  readonly position: string;
  readonly parent?: number;
  readonly archivedAtHours?: number;
  readonly source?: FixtureTaskSource;
  readonly createdHours: number;
}

const taskSeeds: readonly TaskSeed[] = [
  // Now (UI sample, workspace_now)
  { id: 0x101, title: "Refresh my portfolio", collection: "now", position: "a0", createdHours: 2 },
  {
    id: 0x102,
    title: "Pick five projects to feature",
    collection: "now",
    position: "a0",
    parent: 0x101,
    createdHours: 3,
  },
  {
    id: 0x103,
    title:
      "Rewrite the about page so it sounds like me and not like a résumé written for someone else",
    collection: "now",
    position: "a1",
    parent: 0x101,
    createdHours: 3,
  },
  {
    id: 0x104,
    title: "Send the project outline",
    collection: "now",
    position: "a1",
    createdHours: 5,
  },
  { id: 0x105, title: "Book a bike tune-up", collection: "now", position: "a2", createdHours: 6 },
  // Later (workspace_later brief)
  {
    id: 0x201,
    title: "Plan a quiet weekend",
    collection: "later",
    position: "a0",
    createdHours: 8,
  },
  {
    id: 0x202,
    title: "Try the pottery class",
    collection: "later",
    position: "a1",
    createdHours: 9,
  },
  {
    id: 0x203,
    title: "Reorganize the photo shelf",
    collection: "later",
    position: "a2",
    createdHours: 10,
  },
  // Unclassified (workspace_unclassified brief)
  {
    id: 0x301,
    title: "Look into a standing desk",
    collection: "unclassified",
    position: "a0",
    createdHours: 12,
  },
  {
    id: 0x302,
    title: "Notes from the weekend",
    collection: "unclassified",
    position: "a1",
    createdHours: 13,
  },
  {
    id: 0x303,
    title: "Review the outline",
    collection: "unclassified",
    position: "a2",
    source: `mcp:${mayaMcpGrantId}`,
    createdHours: 14,
  },
  // Archive (archive brief)
  {
    id: 0x401,
    title: "Book the pottery class",
    collection: "later",
    position: "a3",
    archivedAtHours: 30,
    createdHours: 1,
  },
  {
    id: 0x402,
    title: "Choose portfolio photos",
    collection: "now",
    position: "a3",
    archivedAtHours: 40,
    createdHours: 1,
  },
];

export const mayaTasks: readonly FixtureTask[] = taskSeeds.map((seed) => {
  const archivedAt = seed.archivedAtHours === undefined ? null : at(seed.archivedAtHours);
  return {
    id: fixtureId(seed.id),
    ownerId: mayaUser.id,
    parentId: seed.parent === undefined ? null : fixtureId(seed.parent),
    collection: seed.collection,
    position: seed.position,
    status: archivedAt === null ? "active" : "archived",
    archivedAt,
    archivedWithRootId: archivedAt === null ? null : fixtureId(seed.id),
    source: seed.source ?? "user",
    title: seed.title,
    createdAt: at(seed.createdHours),
    updatedAt: archivedAt ?? at(seed.createdHours + 1),
  };
});

/** Looks up a Maya task by its exact title. */
export function mayaTask(title: string): FixtureTask {
  const task = mayaTasks.find((entry) => entry.title === title);
  if (!task) throw new Error(`No Maya fixture task titled "${title}"`);
  return task;
}

const documentSeeds: ReadonlyArray<readonly [number, string]> = [
  [
    0x101,
    `## Overview
A lighter, quieter portfolio. Fewer projects, better writing, and a page that loads fast on a phone.

> Rule of thumb: if I wouldn't bring it up in a conversation, it doesn't go on the site.

## Projects to feature
- [x] Field notes app — the one people actually ask about
- [x] Library redesign for the city archive
- [ ] The typography experiments (pick two, not nine)
- [ ] Short write-up of the weather station, with photos
- [ ] Decide whether the illustration work belongs here at all

## Next steps
1. Draft the about page in plain sentences
2. Export project images at 1600px, WebP
3. Ask the agent to check every link on the current site

| Section | Status | Owner |
| --- | --- | --- |
| About | Draft | Me |
| Projects | Selecting | Me |
| Contact | Done | Me |

## Links
- Current site (private staging)
- Image export preset:

\`\`\`bash
magick in.png -resize 1600x -quality 82 out.webp
\`\`\`
`,
  ],
  [
    0x102,
    `## Shortlist
- Field notes app
- Library redesign
- Weather station write-up
- Two typography experiments
`,
  ],
  [
    0x103,
    `## Notes
Write it the way I'd say it out loud. One paragraph about what I make, one about how I work, one about what I'm looking for.
`,
  ],
  [
    0x104,
    `## Outline
Draft outline for the Q4 community garden project. Covers goals, timeline, and a rough budget.

## Recipients
- Priya (project lead)
- The volunteers list

## Status
Draft is ready. The agent is waiting for approval before sending anything.
`,
  ],
  [0x105, ""],
  [
    0x201,
    `## Idea
One weekend with no plans before 10am.

## Maybe
- Farmers market on Saturday
- Long walk by the water
- Finish the novel on the nightstand

## Not this time
- Errands
- Inbox
`,
  ],
  [
    0x202,
    `## Options
- Tuesday evening wheel-throwing, six weeks
- Saturday hand-building drop-in

## Questions
1. Do they provide aprons?
2. Can I keep what I make?
`,
  ],
  [0x203, ""],
  [
    0x301,
    `## What I need
- Fits the alcove by the window
- Quiet motor
- Under the budget I set in the spreadsheet
`,
  ],
  [
    0x302,
    `## Notes
- Try the new bakery earlier; it sells out by noon
- Call back about the bike tune-up slot
`,
  ],
  [
    0x303,
    `## Review
Read the outline for the community garden project and leave comments inline.
`,
  ],
];

export const mayaDocuments: readonly FixtureDocument[] = documentSeeds.map(([id, markdown]) => ({
  taskId: fixtureId(id),
  markdown,
}));

/** The document of a Maya task. */
export function mayaDocument(taskId: string): FixtureDocument {
  const document = mayaDocuments.find((entry) => entry.taskId === taskId);
  if (!document) throw new Error(`No Maya fixture document for task ${taskId}`);
  return document;
}

export const mayaConversations: readonly FixtureConversation[] = [
  {
    id: fixtureId(0x501),
    kind: "task",
    taskId: fixtureId(0x101),
    messages: [
      {
        id: fixtureId(0x5011),
        role: "user",
        text: "Can you check which project images are still missing?",
        activity: [],
        approval: null,
        createdAt: at(20),
      },
      {
        id: fixtureId(0x5012),
        role: "assistant",
        text: "Three of the five projects have no image yet: the typography experiments, the weather station write-up, and the illustration work. Field notes and the library redesign both have exports in the Links section.",
        activity: [
          {
            label: "Reading Projects to feature",
            tool: "task_document_read_section",
            status: "done",
            detail: 'section: "Projects to feature" (rev 12)\n5 items · 412 chars',
          },
        ],
        approval: null,
        createdAt: at(20.01),
      },
    ],
  },
  {
    id: fixtureId(0x502),
    kind: "task",
    taskId: fixtureId(0x104),
    messages: [
      {
        id: fixtureId(0x5021),
        role: "user",
        text: "Send the outline to Priya and the volunteers list once it looks fine to you.",
        activity: [],
        approval: null,
        createdAt: at(21),
      },
      {
        id: fixtureId(0x5022),
        role: "assistant",
        text: "The outline reads clearly. I have a draft ready to send from your connected email account. Review it below before anything goes out.",
        activity: [
          {
            label: "Reading Outline",
            tool: "task_document_read_section",
            status: "done",
            detail: 'section: "Outline" (rev 4)',
          },
          {
            label: "Reading Recipients",
            tool: "task_document_read_section",
            status: "done",
            detail: 'section: "Recipients" (rev 4)',
          },
        ],
        approval: { status: "pending", toolSlug: "GMAIL_SEND_EMAIL" },
        createdAt: at(21.01),
      },
    ],
  },
  {
    id: fixtureId(0x503),
    kind: "quick",
    taskId: null,
    messages: [
      {
        id: fixtureId(0x5031),
        role: "user",
        text: "Move the pottery class to Now and remind me Friday at 9.",
        activity: [],
        approval: null,
        createdAt: at(22),
      },
      {
        id: fixtureId(0x5032),
        role: "assistant",
        text: "Moved “Try the pottery class” to Now and set a reminder for Friday, September 18 at 9:00 AM Pacific time.",
        activity: [
          {
            label: "Moving Try the pottery class",
            tool: "task_move",
            status: "done",
            detail: "later → now",
          },
          {
            label: "Adding a reminder",
            tool: "task_schedule",
            status: "done",
            detail: "add_reminder",
          },
        ],
        approval: null,
        createdAt: at(22.01),
      },
    ],
  },
];

/** The whole dataset, for seeding a store in one call. */
export const mayaDataset = {
  user: mayaUser,
  tasks: mayaTasks,
  documents: mayaDocuments,
  conversations: mayaConversations,
} as const;
