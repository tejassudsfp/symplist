import { idSchema } from "@symplist/contracts";
import { describe, expect, it } from "vitest";
import {
  fixtureId,
  mayaConversations,
  mayaDataset,
  mayaDocument,
  mayaDocuments,
  mayaMcpGrantId,
  mayaTask,
  mayaTasks,
  mayaUser,
} from "./maya.ts";

describe("Maya fixture dataset", () => {
  it("uses the fictional account from the design brief", () => {
    expect(mayaUser).toMatchObject({
      displayName: "Maya Rao",
      email: "maya@example.com",
      betaState: "unlocked",
      onboardingStep: "done",
    });
    expect(mayaUser.analyticsId).not.toContain(mayaUser.id);
    expect(mayaDataset.user).toBe(mayaUser);
  });

  it("uses valid, unique UUIDv7 ids everywhere", () => {
    const ids = [
      mayaUser.id,
      mayaMcpGrantId,
      ...mayaTasks.map((task) => task.id),
      ...mayaConversations.flatMap((conversation) => [
        conversation.id,
        ...conversation.messages.map((message) => message.id),
      ]),
    ];
    for (const id of ids) expect(idSchema.safeParse(id).success, id).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => fixtureId(-1)).toThrow(RangeError);
  });

  it("contains the brief's tasks in the right collections", () => {
    const active = (collection: string) =>
      mayaTasks
        .filter(
          (task) =>
            task.collection === collection && task.status === "active" && task.parentId === null,
        )
        .sort((a, b) => a.position.localeCompare(b.position))
        .map((task) => task.title);
    expect(active("now")).toEqual([
      "Refresh my portfolio",
      "Send the project outline",
      "Book a bike tune-up",
    ]);
    expect(active("later")).toEqual([
      "Plan a quiet weekend",
      "Try the pottery class",
      "Reorganize the photo shelf",
    ]);
    expect(active("unclassified")).toEqual([
      "Look into a standing desk",
      "Notes from the weekend",
      "Review the outline",
    ]);
    expect(mayaTask("Review the outline").source).toBe(`mcp:${mayaMcpGrantId}`);
    expect(
      mayaTasks.filter((task) => task.status === "archived").map((task) => task.title),
    ).toEqual(["Book the pottery class", "Choose portfolio photos"]);
    expect(() => mayaTask("Missing")).toThrow();
  });

  it("nests subtasks under an active parent in the same collection with unique sibling positions", () => {
    const parent = mayaTask("Refresh my portfolio");
    const children = mayaTasks.filter((task) => task.parentId === parent.id);
    expect(children.map((task) => task.title)).toEqual([
      "Pick five projects to feature",
      "Rewrite the about page so it sounds like me and not like a résumé written for someone else",
    ]);
    for (const child of children) expect(child.collection).toBe(parent.collection);

    const siblings = new Map<string, string[]>();
    for (const task of mayaTasks.filter((entry) => entry.status === "active")) {
      const group = `${task.collection}:${task.parentId ?? "root"}`;
      siblings.set(group, [...(siblings.get(group) ?? []), task.position]);
    }
    for (const positions of siblings.values())
      expect(new Set(positions).size).toBe(positions.length);
    for (const task of mayaTasks) {
      expect(task.ownerId).toBe(mayaUser.id);
      expect(task.updatedAt).toBeGreaterThanOrEqual(task.createdAt);
      expect(task.archivedAt === null).toBe(task.status === "active");
    }
  });

  it("gives every non-archived task a document with Markdown from the UI sample", () => {
    for (const task of mayaTasks.filter((entry) => entry.status === "active")) {
      expect(
        mayaDocuments.some((document) => document.taskId === task.id),
        task.title,
      ).toBe(true);
    }
    const portfolio = mayaDocument(mayaTask("Refresh my portfolio").id).markdown;
    expect(portfolio).toContain("## Projects to feature");
    expect(portfolio).toContain("```bash");
    expect(portfolio).toContain("| Section | Status | Owner |");
    expect(mayaDocument(mayaTask("Book a bike tune-up").id).markdown).toBe("");
    expect(() => mayaDocument(fixtureId(0xfff))).toThrow();
  });

  it("has task chats with Simon activity, a pending approval, and a quick chat", () => {
    const outline = mayaConversations.find(
      (conversation) => conversation.taskId === mayaTask("Send the project outline").id,
    );
    expect(outline?.messages.at(-1)?.approval).toEqual({
      status: "pending",
      toolSlug: "GMAIL_SEND_EMAIL",
    });
    const portfolio = mayaConversations.find(
      (conversation) => conversation.taskId === mayaTask("Refresh my portfolio").id,
    );
    expect(portfolio?.messages[1]?.activity[0]).toMatchObject({
      label: "Reading Projects to feature",
      tool: "task_document_read_section",
    });
    const quick = mayaConversations.filter((conversation) => conversation.kind === "quick");
    expect(quick).toHaveLength(1);
    expect(quick[0]?.taskId).toBeNull();
    for (const conversation of mayaConversations) {
      const times = conversation.messages.map((message) => message.createdAt);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });
});
