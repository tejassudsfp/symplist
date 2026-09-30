import type { ThemeId } from "@/theme/registry";

/** A label as the demo list shows it: a name and one of the accent presets. */
export interface DemoLabel {
  readonly id: string;
  readonly name: string;
  readonly colour: string;
}

export interface DemoCommit {
  readonly hash: string;
  readonly msg: string;
  readonly when: string;
}

export interface DemoTask {
  readonly id: string;
  readonly title: string;
  readonly list: DemoListId;
  readonly labelId?: string;
  readonly due?: string;
  readonly subs?: string;
  readonly blocks: readonly DemoBlock[];
  readonly history: readonly DemoCommit[];
}

export type DemoListId = "now" | "later" | "unclassified";

export type DemoBlock =
  | { readonly kind: "h"; readonly text: string }
  | { readonly kind: "p"; readonly text: string }
  | { readonly kind: "li"; readonly text: string }
  | { readonly kind: "check"; readonly text: string; readonly checked: boolean };

export const demoLabels: readonly DemoLabel[] = [
  { id: "personal", name: "Personal", colour: "violet" },
  { id: "work", name: "Work", colour: "amber" },
];

export const demoLists: readonly { id: DemoListId; name: string; short: string }[] = [
  { id: "now", name: "Now", short: "Now" },
  { id: "later", name: "Later", short: "Later" },
  { id: "unclassified", name: "Unclassified", short: "Unsorted" },
];

/**
 * The tasks the preview is populated with.
 *
 * Ordinary and slightly dull on purpose: a demo list full of "Launch Q3 growth initiative" is selling
 * a project tracker, and this is a place to write down that the porch light needs fixing.
 */
export const demoTasks: readonly DemoTask[] = [
  {
    id: "a",
    title: "Refresh my portfolio",
    list: "now",
    labelId: "personal",
    subs: "2 subtasks",
    blocks: [
      { kind: "h", text: "Overview" },
      {
        kind: "p",
        text: "A lighter, quieter portfolio. Fewer projects, better writing, and a page that loads fast on a phone.",
      },
      { kind: "h", text: "Projects to feature" },
      { kind: "check", text: "Field notes app", checked: true },
      { kind: "check", text: "Library redesign for the city archive", checked: true },
      { kind: "check", text: "Two typography experiments, not nine", checked: false },
      { kind: "check", text: "Weather station write-up, with photos", checked: false },
      { kind: "h", text: "Next" },
      { kind: "li", text: "Draft the about page in plain sentences" },
      { kind: "li", text: "Export images at 1600px" },
    ],
    history: [
      { hash: "4e1c9a2", msg: "Edited Next", when: "Just now" },
      { hash: "b7d03f5", msg: "Checked two projects", when: "Yesterday" },
      { hash: "19aa6e0", msg: "Added Projects to feature", when: "Sep 26" },
      { hash: "0c52d81", msg: "Created page", when: "Sep 24" },
    ],
  },
  {
    id: "b",
    title: "Send the project outline",
    list: "now",
    labelId: "work",
    due: "Fri 3 Oct",
    blocks: [
      { kind: "h", text: "Outline" },
      {
        kind: "p",
        text: "Goals, timeline and a rough budget for the Q4 community garden project.",
      },
      { kind: "h", text: "Before sending" },
      { kind: "check", text: "Check the budget numbers", checked: true },
      { kind: "check", text: "Add the volunteer schedule", checked: false },
      { kind: "check", text: "Send to Priya and the volunteers list", checked: false },
    ],
    history: [
      { hash: "a93f11c", msg: "Added Before sending", when: "Today" },
      { hash: "5d2e7b0", msg: "Created page", when: "Sep 29" },
    ],
  },
  {
    id: "c",
    title: "Book a bike tune-up",
    list: "now",
    blocks: [
      { kind: "h", text: "Details" },
      {
        kind: "p",
        text: "Rear brake rubs and the chain needs replacing. Ask about a full service price.",
      },
      { kind: "check", text: "Call the shop on Elm Street", checked: false },
    ],
    history: [{ hash: "e04b6d9", msg: "Created page", when: "Sep 28" }],
  },
  {
    id: "d",
    title: "Plan a quiet weekend",
    list: "later",
    labelId: "personal",
    blocks: [
      { kind: "h", text: "Ideas" },
      { kind: "li", text: "No plans before noon" },
      { kind: "li", text: "A long walk, one book, one good meal" },
      { kind: "li", text: "Phone in a drawer" },
    ],
    history: [{ hash: "7f3a120", msg: "Created page", when: "Sep 20" }],
  },
  {
    id: "e",
    title: "Try the pottery class",
    list: "later",
    blocks: [
      { kind: "h", text: "Notes" },
      {
        kind: "p",
        text: "The community studio runs intro sessions on Thursday evenings. Bring an apron.",
      },
    ],
    history: [{ hash: "c1e8d44", msg: "Created page", when: "Sep 18" }],
  },
  {
    id: "f",
    title: "Look into a standing desk",
    list: "unclassified",
    labelId: "work",
    blocks: [
      { kind: "h", text: "Why" },
      { kind: "p", text: "Back has been sore after long writing days." },
      { kind: "h", text: "Compare" },
      { kind: "li", text: "Manual crank or electric" },
      { kind: "li", text: "Whether the current desk fits a converter" },
    ],
    history: [{ hash: "2b9f0e7", msg: "Created page", when: "Sep 27" }],
  },
  {
    id: "g",
    title: "Notes from the walk",
    list: "unclassified",
    blocks: [
      {
        kind: "p",
        text: "A small newsletter. Fixing the porch light. Calling Nana on Sunday.",
      },
    ],
    history: [{ hash: "8d4c3a1", msg: "Created page", when: "Sep 30" }],
  },
];

export interface Tour {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly body: string;
}

/** Each tab is one thing the product does, and puts the preview into the state that shows it. */
export const tours: readonly Tour[] = [
  {
    id: "lists",
    label: "Three lists",
    title: "Now, Later, Unclassified",
    body: "Switch lists from the rail. Tick a task’s box to finish it; it goes to the archive with its page.",
  },
  {
    id: "page",
    label: "The page",
    title: "A page behind every task",
    body: "Each task opens one Markdown page. Tick an item and it saves on its own.",
  },
  {
    id: "history",
    label: "History",
    title: "Real Git history",
    body: "Every save is a commit. Pick an older version and restore it; nothing is lost either way.",
  },
  {
    id: "labels",
    label: "Labels",
    title: "Labels, only if you want them",
    body: "Your own words, one colour each. Filter the list from the bar above it.",
  },
  {
    id: "search",
    label: "⌘K",
    title: "Search and jump",
    body: "The palette finds any task or command. Try typing “later” or “bike”.",
  },
];

export const themeChips: readonly { id: ThemeId; name: string }[] = [
  { id: "studio", name: "Studio" },
  { id: "paper", name: "Paper" },
  { id: "pebble", name: "Pebble" },
  { id: "postcard", name: "Postcard" },
  { id: "meadow", name: "Meadow" },
  { id: "tide", name: "Tide" },
];
