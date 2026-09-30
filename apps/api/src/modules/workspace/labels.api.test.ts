import {
  errorEnvelopeSchema,
  LABEL_MAX_PER_TASK,
  labelListSchema,
  labelViewSchema,
  taskCreateResponseSchema,
  taskLabelsSchema,
  taskTreeResponseSchema,
} from "@symplist/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApp, type TestApp, type TestSession } from "../../../test/harness.ts";

const apps: TestApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function boot(): Promise<TestApp> {
  const app = await bootTestApp();
  apps.push(app);
  return app;
}

let keySequence = 0;
function key(): string {
  keySequence += 1;
  return `labels-key-${String(keySequence).padStart(8, "0")}`;
}

function code(response: { json<T>(): T }): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

async function signedIn(app: TestApp) {
  const user = await app.createSignedInUser("admitted");
  return {
    session: user.session,
    id: user.id,
    async task(title: string): Promise<string> {
      const response = await app.post("/v1/tasks", {
        session: user.session,
        body: { title, collection: "now" },
        idempotencyKey: key(),
      });
      expect(response.status, response.text).toBe(201);
      return taskCreateResponseSchema.parse(response.json()).task.id;
    },
    async label(name: string, colour = "blue"): Promise<string> {
      const response = await app.post("/v1/labels", {
        session: user.session,
        body: { name, colour },
      });
      expect(response.status, response.text).toBe(201);
      return labelViewSchema.parse(response.json()).id;
    },
  };
}

describe("label routes (§2.1)", () => {
  it("creates, lists, renames, recolours and deletes labels over HTTP", async () => {
    const app = await boot();
    const maya = await signedIn(app);

    const created = await app.post("/v1/labels", {
      session: maya.session,
      body: { name: "  Deep   work ", colour: "violet" },
    });
    expect(created.status, created.text).toBe(201);
    // Normalised by the contract on the way in, so the chip and the uniqueness check agree.
    const deep = labelViewSchema.parse(created.json());
    expect(deep).toMatchObject({ name: "Deep work", colour: "violet", taskCount: 0 });

    // The list is ordered by `created_at, id`. The harness clock is frozen, so without advancing it
    // both labels share a millisecond and the random uuid tail decides — which made this flake.
    await app.clock.advance(1);
    const errand = await maya.label("Errands", "amber");
    const list = await app.get("/v1/labels", { session: maya.session });
    expect(list.status).toBe(200);
    expect(labelListSchema.parse(list.json()).labels.map((label) => label.name)).toEqual([
      "Deep work",
      "Errands",
    ]);

    const patched = await app.request("PATCH", `/v1/labels/${errand}`, {
      session: maya.session,
      body: { name: "Errand", colour: "teal" },
    });
    expect(patched.status, patched.text).toBe(200);
    expect(labelViewSchema.parse(patched.json())).toMatchObject({ name: "Errand", colour: "teal" });

    const removed = await app.request("DELETE", `/v1/labels/${deep.id}`, { session: maya.session });
    expect(removed.status).toBe(204);
    expect(removed.text).toBe("");
    const after = await app.get("/v1/labels", { session: maya.session });
    expect(labelListSchema.parse(after.json()).labels.map((label) => label.name)).toEqual([
      "Errand",
    ]);
    // A delete of a label already gone is 404 rather than a silent success.
    const again = await app.request("DELETE", `/v1/labels/${deep.id}`, { session: maya.session });
    expect(again.status).toBe(404);
    expect(code(again)).toBe("label.unknown");
  });

  it("answers a duplicate name with 409 and the id of the label that already has it", async () => {
    // This is what makes the create route safe to retry without an Idempotency-Key: a retry after a
    // lost response is told the id its first attempt made.
    const app = await boot();
    const maya = await signedIn(app);
    const work = await maya.label("Work");
    const clash = await app.post("/v1/labels", {
      session: maya.session,
      body: { name: "  work  ", colour: "rose" },
    });
    expect(clash.status).toBe(409);
    const envelope = errorEnvelopeSchema.parse(clash.json());
    expect(envelope.error.code).toBe("label.duplicate_name");
    expect(envelope.error.details).toEqual({ labelId: work });
  });

  it("puts a task's labels as a whole set, and shows them on the tree", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const work = await maya.label("Work");
    const urgent = await maya.label("Urgent", "coral");
    const task = await maya.task("Send the outline");

    const set = await app.request("PUT", `/v1/tasks/${task}/labels`, {
      session: maya.session,
      body: { labelIds: [urgent, work] },
    });
    expect(set.status, set.text).toBe(200);
    const listed = labelListSchema
      .parse((await app.get("/v1/labels", { session: maya.session })).json())
      .labels.map((label) => label.id);
    expect([...listed].sort()).toEqual([work, urgent].sort());
    // Sent in one order and returned in the owner's, which is the order the chips render in — so a
    // task row and the filter bar never disagree about which label comes first.
    expect(taskLabelsSchema.parse(set.json())).toEqual({ taskId: task, labelIds: listed });

    const tree = await app.get("/v1/tasks?collection=now", { session: maya.session });
    const body = taskTreeResponseSchema.parse(tree.json());
    expect(body.tasks[0]).toMatchObject({ id: task, labelIds: listed });
    expect(body.labels.map((label) => [label.id, label.name, label.taskCount])).toEqual(
      listed.map((id) => [id, id === work ? "Work" : "Urgent", 1]),
    );

    // A second PUT replaces rather than merges, which is what makes the route idempotent.
    const narrowed = await app.request("PUT", `/v1/tasks/${task}/labels`, {
      session: maya.session,
      body: { labelIds: [work] },
    });
    expect(taskLabelsSchema.parse(narrowed.json()).labelIds).toEqual([work]);
    const replayed = await app.request("PUT", `/v1/tasks/${task}/labels`, {
      session: maya.session,
      body: { labelIds: [work] },
    });
    expect(taskLabelsSchema.parse(replayed.json()).labelIds).toEqual([work]);
  });

  it("refuses more labels on one task than a row can show", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const ids: string[] = [];
    for (let index = 0; index <= LABEL_MAX_PER_TASK; index++) {
      ids.push(await maya.label(`Label ${index}`));
    }
    const task = await maya.task("Too many chips");
    const refused = await app.request("PUT", `/v1/tasks/${task}/labels`, {
      session: maya.session,
      body: { labelIds: ids },
    });
    // The contract's own `max` catches it before the service does, so this is a validation refusal
    // rather than `label.limit_reached`. The service's own caps are covered in
    // `packages/core/src/tasks/label-service.test.ts`, which is the only thing an MCP tool goes through.
    expect(refused.status).toBe(400);
    expect(code(refused)).toBe("validation");
  });

  it("keeps one account's labels out of another's reach", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const sam = await signedIn(app);
    const mine = await maya.label("Mine");
    const myTask = await maya.task("My task");

    for (const [method, path, body] of [
      ["PATCH", `/v1/labels/${mine}`, { colour: "rose" }],
      ["DELETE", `/v1/labels/${mine}`, undefined],
    ] as const) {
      const response = await app.request(method, path, {
        session: sam.session,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(code(response)).toBe("label.unknown");
    }

    const theirLabel = await sam.label("Theirs");
    const crossLabel = await app.request("PUT", `/v1/tasks/${myTask}/labels`, {
      session: maya.session,
      body: { labelIds: [theirLabel] },
    });
    expect(crossLabel.status).toBe(404);
    expect(code(crossLabel)).toBe("label.unknown");

    const crossTask = await app.request("PUT", `/v1/tasks/${myTask}/labels`, {
      session: sam.session,
      body: { labelIds: [theirLabel] },
    });
    expect(crossTask.status).toBe(404);
    expect(code(crossTask)).toBe("not_found");
    expect(
      labelListSchema
        .parse((await app.get("/v1/labels", { session: sam.session })).json())
        .labels.map((label) => label.name),
    ).toEqual(["Theirs"]);
  });

  it("requires a session on every label route", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const label = await maya.label("Work");
    const unauthenticated: Array<[string, string, object | undefined, TestSession | undefined]> = [
      ["GET", "/v1/labels", undefined, undefined],
      ["POST", "/v1/labels", { name: "x", colour: "blue" }, undefined],
      ["PATCH", `/v1/labels/${label}`, { colour: "rose" }, undefined],
      ["DELETE", `/v1/labels/${label}`, undefined, undefined],
    ];
    for (const [method, path, body] of unauthenticated) {
      const response = await app.request(method, path, body === undefined ? {} : { body });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});
