import { randomBytes } from "node:crypto";
import { LABEL_MAX_PER_OWNER, LABEL_MAX_PER_TASK, labelViewSchema } from "@symplist/contracts";
import { createKeyProvider, keyFamilies, type ManagedKeyProvider } from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountKeyStore } from "../account/keys.ts";
import { TaskOperationError } from "./errors.ts";
import { LabelService } from "./label-service.ts";
import { type TaskActor, TaskService } from "./service.ts";
import { onTaskTreeCommitted, type TaskTreeCommit } from "./signals.ts";
import { MemoryTaskTreeCache } from "./state.ts";

/**
 * Labels.
 *
 * The properties worth pinning are the ones a reader cannot see from the schema: the name is encrypted
 * and never reaches the database in the clear; uniqueness is enforced in this service because the
 * encryption makes an index impossible; a label write moves the task tree version, because the tree
 * response carries labels and a stale version would leave an old name on screen; and no id from another
 * account can be used, however it is presented.
 */
const start = Date.UTC(2026, 8, 15, 9, 0, 0);
let clock = start;
const now = () => clock;
let db: LocalSqliteClient;
let keys: ManagedKeyProvider;
const user: TaskActor = { kind: "user" };

beforeEach(async () => {
  clock = start;
  const versions = new Map([[1, randomBytes(32)]]);
  keys = createKeyProvider(
    Object.fromEntries(keyFamilies.map((family) => [family, { current: 1, versions }])),
  );
  db = createLocalSqliteClient({ path: ":memory:" });
  await applyMigrations(db);
});

afterEach(() => {
  keys.destroy();
  db.close();
});

async function insertUser(): Promise<string> {
  const id = uuidv7(clock);
  await db.batch([
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, onboarding_step, created_at, updated_at, write_id)
       VALUES (:id, :email, :now, 'unlocked', 'done', :now, :now, :w)`,
      { id, email: `${id}@example.test`, now: int(clock), w: uuidv7(clock) },
    ),
    new AccountKeyStore({ db, keys }).provisionStatement({ userId: id, now: clock }),
  ]);
  return id;
}

const labels = () => new LabelService({ db, keys, policy: { betaAccessRequired: true }, now });

const tasks = () =>
  new TaskService({
    db,
    keys,
    policy: { betaAccessRequired: true },
    now,
    cache: new MemoryTaskTreeCache({ now }),
    archiveContributors: [],
  });

async function createTask(owner: string, title: string): Promise<string> {
  clock += 1;
  const result = await tasks().create({
    ownerId: owner,
    actor: user,
    title,
    collection: "unclassified",
  });
  if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
  return (result.body as { task: { id: string } }).task.id;
}

async function treeVersion(owner: string): Promise<number> {
  const row = await db.first(
    sql("SELECT task_tree_version AS v FROM users WHERE id = :id", { id: owner }),
  );
  return Number(row?.v);
}

describe("labels", () => {
  it("stores the name encrypted and never in the clear", async () => {
    const owner = await insertUser();
    await labels().create(owner, { name: "Waiting on Ana", colour: "violet" });
    const row = await db.first(sql("SELECT name_enc, colour FROM labels"));
    expect(String(row?.name_enc)).toMatch(/^sym1\./);
    // The colour is deliberately *not* encrypted: it has to be readable to render a list without
    // unwrapping a key, and an accent preset name is not the owner's content.
    expect(row?.colour).toBe("violet");
    const scan = await db.all(sql("SELECT name_enc FROM labels"));
    expect(JSON.stringify(scan)).not.toContain("Waiting on Ana");
  });

  it("reads back what was written, and validates against the response contract", async () => {
    const owner = await insertUser();
    const created = await labels().create(owner, { name: "  Deep   work  ", colour: "teal" });
    // The name is normalised on the way in, so the chip and the uniqueness check agree.
    expect(created.name).toBe("Deep work");
    expect(() => labelViewSchema.parse(created)).not.toThrow();
    const list = await labels().list(owner);
    expect(list.labels).toEqual([expect.objectContaining({ name: "Deep work", taskCount: 0 })]);
  });

  it("refuses a duplicate name, ignoring case and surrounding space", async () => {
    const owner = await insertUser();
    const first = await labels().create(owner, { name: "Work", colour: "blue" });
    for (const name of ["Work", "work", "  WORK  "]) {
      await expect(labels().create(owner, { name, colour: "rose" })).rejects.toMatchObject({
        code: "label.duplicate_name",
        details: { labelId: first.id },
      });
    }
    // Accents are a real difference, so these are two labels rather than a collision.
    await expect(labels().create(owner, { name: "café", colour: "amber" })).resolves.toBeDefined();
    await expect(labels().create(owner, { name: "cafe", colour: "green" })).resolves.toBeDefined();
  });

  it("caps how many labels one owner may have", async () => {
    const owner = await insertUser();
    for (let index = 0; index < LABEL_MAX_PER_OWNER; index++) {
      clock += 1;
      await labels().create(owner, { name: `label ${index}`, colour: "graphite" });
    }
    await expect(
      labels().create(owner, { name: "one more", colour: "blue" }),
    ).rejects.toMatchObject({
      code: "label.limit_reached",
      details: { limit: LABEL_MAX_PER_OWNER },
    });
  });

  it("puts labels on a task, replacing the whole set rather than adding to it", async () => {
    const owner = await insertUser();
    const work = await labels().create(owner, { name: "work", colour: "blue" });
    clock += 1;
    const home = await labels().create(owner, { name: "home", colour: "green" });
    const task = await createTask(owner, "Book the thing");

    await labels().setTaskLabels(owner, task, [work.id, home.id]);
    const page = await tasks().listCollection(owner, "unclassified");
    expect(page.tasks[0]?.labelIds).toEqual([work.id, home.id]);

    // Replacing, not merging: `home` is gone because it was not in the new set.
    await labels().setTaskLabels(owner, task, [home.id]);
    expect((await tasks().listCollection(owner, "unclassified")).tasks[0]?.labelIds).toEqual([
      home.id,
    ]);
    await labels().setTaskLabels(owner, task, []);
    expect((await tasks().listCollection(owner, "unclassified")).tasks[0]?.labelIds).toEqual([]);
  });

  it("orders a task's chips by the owner's label order, not by when they were attached", async () => {
    const owner = await insertUser();
    const first = await labels().create(owner, { name: "aaa", colour: "blue" });
    clock += 1;
    const second = await labels().create(owner, { name: "bbb", colour: "rose" });
    const task = await createTask(owner, "Ordered");
    await labels().setTaskLabels(owner, task, [second.id, first.id]);
    const page = await tasks().listCollection(owner, "unclassified");
    expect(page.tasks[0]?.labelIds).toEqual([first.id, second.id]);
  });

  it("caps how many labels one task may carry", async () => {
    const owner = await insertUser();
    const ids: string[] = [];
    for (let index = 0; index <= LABEL_MAX_PER_TASK; index++) {
      clock += 1;
      ids.push((await labels().create(owner, { name: `l${index}`, colour: "blue" })).id);
    }
    const task = await createTask(owner, "Too many");
    await expect(labels().setTaskLabels(owner, task, ids)).rejects.toMatchObject({
      code: "label.limit_reached",
      details: { limit: LABEL_MAX_PER_TASK },
    });
  });

  it("counts only active tasks, so an archived task stops counting toward a label", async () => {
    const owner = await insertUser();
    const label = await labels().create(owner, { name: "counted", colour: "coral" });
    const task = await createTask(owner, "Will be completed");
    await labels().setTaskLabels(owner, task, [label.id]);
    expect((await labels().list(owner)).labels[0]?.taskCount).toBe(1);
    clock += 1;
    await tasks().complete({ ownerId: owner, taskId: task, mode: "all", stopRun: false });
    expect((await labels().list(owner)).labels[0]?.taskCount).toBe(0);
  });

  it("moves the task tree version on every label write, so no client serves a stale name", async () => {
    // Labels ride in the tree response. Without this a rename would sit behind a cached version until
    // its TTL expired, and a second device would never be told to re-read.
    const owner = await insertUser();
    const before = await treeVersion(owner);
    const label = await labels().create(owner, { name: "first", colour: "blue" });
    const afterCreate = await treeVersion(owner);
    expect(afterCreate).toBeGreaterThan(before);
    clock += 1;
    await labels().update(owner, label.id, { name: "renamed" });
    expect(await treeVersion(owner)).toBeGreaterThan(afterCreate);
    clock += 1;
    await labels().remove(owner, label.id);
    expect(await treeVersion(owner)).toBeGreaterThan(afterCreate + 1);
  });

  it("announces each write on the task tree signal, so the api evicts and republishes", async () => {
    // The same signal `TaskService` announces on: subscribing is how the api's tree cache and
    // `tasks.changed` learn about a label without the label routes knowing either exists.
    const owner = await insertUser();
    const label = await labels().create(owner, { name: "x", colour: "blue" });
    const task = await createTask(owner, "Labelled");
    const seen: TaskTreeCommit[] = [];
    const unsubscribe = onTaskTreeCommitted(db, (commit) => seen.push(commit));
    try {
      await labels().setTaskLabels(owner, task, [label.id]);
      clock += 1;
      await labels().update(owner, label.id, { colour: "rose" });
      clock += 1;
      await labels().remove(owner, label.id);
    } finally {
      unsubscribe();
    }
    expect(seen.map((commit) => commit.ownerId)).toEqual([owner, owner, owner]);
    const versions = seen.map((commit) => commit.taskTreeVersion);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    // Setting a task's chips names that task; a label's own rename or delete names none, because it
    // touches every row carrying it and an empty list is how this signal says "re-read".
    expect(seen.map((commit) => [...commit.taskIds])).toEqual([[task], [], []]);
  });

  it("renames and recolours, and refuses a rename onto another label's name", async () => {
    const owner = await insertUser();
    const work = await labels().create(owner, { name: "work", colour: "blue" });
    clock += 1;
    const home = await labels().create(owner, { name: "home", colour: "green" });
    clock += 1;
    const renamed = await labels().update(owner, work.id, { name: "job", colour: "amber" });
    expect(renamed).toMatchObject({ id: work.id, name: "job", colour: "amber" });
    await expect(labels().update(owner, work.id, { name: "home" })).rejects.toMatchObject({
      code: "label.duplicate_name",
      details: { labelId: home.id },
    });
    // Renaming a label to the name it already has is accepted rather than treated as a collision.
    await expect(labels().update(owner, work.id, { name: "job" })).resolves.toMatchObject({
      name: "job",
    });
  });

  it("deletes a label and every chip for it", async () => {
    const owner = await insertUser();
    const label = await labels().create(owner, { name: "temporary", colour: "blue" });
    const task = await createTask(owner, "Labelled");
    await labels().setTaskLabels(owner, task, [label.id]);
    clock += 1;
    await labels().remove(owner, label.id);
    expect((await labels().list(owner)).labels).toEqual([]);
    const pairs = await db.all(sql("SELECT task_id FROM task_labels"));
    expect(pairs).toEqual([]);
    expect((await tasks().listCollection(owner, "unclassified")).tasks[0]?.labelIds).toEqual([]);
  });

  it("never lets one account touch another's labels or tasks", async () => {
    const mine = await insertUser();
    clock += 1;
    const theirs = await insertUser();
    const theirLabel = await labels().create(theirs, { name: "theirs", colour: "blue" });
    const myTask = await createTask(mine, "Mine");
    const theirTask = await createTask(theirs, "Theirs");

    // Their label id, presented by me: unknown and foreign read the same.
    await expect(labels().setTaskLabels(mine, myTask, [theirLabel.id])).rejects.toMatchObject({
      code: "label.unknown",
    });
    await expect(labels().update(mine, theirLabel.id, { colour: "rose" })).rejects.toMatchObject({
      code: "label.unknown",
    });
    await expect(labels().remove(mine, theirLabel.id)).rejects.toMatchObject({
      code: "label.unknown",
    });
    // And my label on their task.
    const myLabel = await labels().create(mine, { name: "mine", colour: "green" });
    await expect(labels().setTaskLabels(mine, theirTask, [myLabel.id])).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await labels().list(theirs)).labels).toEqual([
      expect.objectContaining({ name: "theirs" }),
    ]);
  });

  it("refuses an unknown label id and an unknown task", async () => {
    const owner = await insertUser();
    const task = await createTask(owner, "Real");
    await expect(labels().setTaskLabels(owner, task, [uuidv7(clock)])).rejects.toMatchObject({
      code: "label.unknown",
    });
    const label = await labels().create(owner, { name: "real", colour: "blue" });
    await expect(labels().setTaskLabels(owner, uuidv7(clock), [label.id])).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses every write from an account that is not admitted", async () => {
    const owner = await insertUser();
    await db.run(sql("UPDATE users SET beta_state = 'relocked' WHERE id = :id", { id: owner }));
    await expect(labels().create(owner, { name: "nope", colour: "blue" })).rejects.toBeInstanceOf(
      TaskOperationError,
    );
  });
});
