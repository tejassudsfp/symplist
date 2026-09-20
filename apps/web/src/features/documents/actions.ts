import type { ActionAvailability, AppAction } from "@/actions/types";
import { activeDocument } from "./controller.ts";
import { outlineRequestHandler } from "./outline-request.ts";
import { documentHistoryPath, taskArtifactsPath } from "./routes.ts";

/**
 * Actions contributed by the documents feature to the command registry (§10.2, note 13). The page's
 * own buttons invoke the same ids, so a shortcut is never a second path around a check.
 *
 * `g h` opens Document history, `Mod+S` saves the open page and `Mod+F` finds within it; both editor
 * actions apply only while the document editor holds focus, so browser find and save stay available
 * everywhere else.
 */

const enabled: ActionAvailability = { enabled: true };
const noPage: ActionAvailability = { enabled: false, reason: "Open a task page first" };

export const documentsActions: readonly AppAction[] = [
  {
    id: "documents.open_history",
    label: "Document history",
    context: "app",
    group: "page",
    keywords: ["revisions", "versions", "compare", "restore", "restore document revision"],
    defaultBinding: "g h",
    availability: ({ services }) =>
      services.route?.taskId ? enabled : { enabled: false, reason: "Open a task first" },
    run: ({ services }) => {
      const route = services.route;
      if (!route?.taskId) return;
      services.navigate(documentHistoryPath(route.taskId, `/${route.collection}/${route.taskId}`));
    },
  },
  {
    id: "documents.open_artifacts",
    label: "Artifacts and links",
    context: "app",
    group: "page",
    keywords: ["share", "shared link", "snapshot", "revoke", "published"],
    availability: ({ services }) =>
      services.route?.taskId ? enabled : { enabled: false, reason: "Open a task first" },
    run: ({ services }) => {
      const route = services.route;
      if (!route?.taskId) return;
      services.navigate(taskArtifactsPath(route.taskId, `/${route.collection}/${route.taskId}`));
    },
  },
  {
    id: "documents.save",
    label: "Save this page",
    context: "editor",
    group: "page",
    keywords: ["publish", "commit"],
    defaultBinding: "mod+s",
    availability: () => {
      const document = activeDocument();
      if (!document) return noPage;
      return document.editable ? enabled : { enabled: false, reason: "This page is read-only" };
    },
    run: () => {
      activeDocument()?.save();
    },
  },
  {
    id: "documents.find_in_document",
    label: "Find in this page",
    context: "editor",
    group: "page",
    keywords: ["search"],
    defaultBinding: "mod+f",
    availability: () => (activeDocument() ? enabled : noPage),
    run: () => {
      activeDocument()?.find();
    },
  },
  {
    id: "documents.ask_outline",
    label: "Ask Simon for an outline",
    context: "app",
    group: "page",
    keywords: ["draft", "simon", "start"],
    availability: ({ services }) => {
      if (!services.route?.taskId) return { enabled: false, reason: "Open a task first" };
      return outlineRequestHandler()
        ? enabled
        : { enabled: false, reason: "Simon isn't available yet" };
    },
    run: async ({ services }) => {
      const taskId = services.route?.taskId;
      const handler = outlineRequestHandler();
      if (!taskId || !handler) return;
      await handler(taskId);
      services.shell?.focusPane("chat");
    },
  },
];
