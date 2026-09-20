import { simonConversationViewSchema } from "@symplist/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError, ApiNetworkError } from "@/lib/api";
import type { SimonApi } from "./api.ts";
import { SimonStore } from "./store.ts";

const id = "01995000-0000-7000-8000-000000000001";
const task = "01995000-0000-7000-8000-000000000002";
const run = "01995000-0000-7000-8000-000000000003";
const view = simonConversationViewSchema.parse({
  conversationId: id,
  kind: "task",
  taskId: task,
  activeRun: null,
  pendingApprovalId: null,
  pendingAskId: null,
  messages: [],
  nextBeforeSeq: null,
});
function fakeSimonApi() {
  return {
    create: vi.fn<SimonApi["create"]>(async () => ({ conversationId: id })),
    history: vi.fn(async () => view),
    send: vi.fn<SimonApi["send"]>(async () => ({ messageId: run, runId: run, status: "accepted" })),
    stop: vi.fn(async () => ({ runId: run })),
    retry: vi.fn(async () => ({ runId: run })),
    close: vi.fn<SimonApi["close"]>(async () => ({ conversationId: id, runId: null })),
    save: vi.fn(async () => ({ conversationId: id, taskId: task, collection: "now" as const })),
    approval: vi.fn<SimonApi["approval"]>(),
    ask: vi.fn<SimonApi["ask"]>(),
    decide: vi.fn(async () => ({})),
    answer: vi.fn(async () => ({ runId: run })),
    dismiss: vi.fn(async () => ({ runId: run })),
  } satisfies SimonApi;
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function opened() {
  const api = fakeSimonApi();
  const store = new SimonStore(api, null);
  const off = store.watch(task);
  await vi.waitFor(() => expect(store.get(task).projection.view).toEqual(view));
  return { api, store, off };
}
describe("owner-scoped Simon store", () => {
  it("preserves drafts/tier but releases history when switching tasks", async () => {
    const { store, off } = await opened();
    store.draft(task, "Draft for the first task");
    store.tier(task, "smart");
    off();
    expect(store.get(task)).toMatchObject({
      draft: "Draft for the first task",
      tier: "smart",
      projection: { view: null },
    });
    expect(store.get(run).draft).toBe("");
    expect(new SimonStore(fakeSimonApi(), null).get(task).draft).toBe("");
  });
  it("survives Strict Mode cleanup and setup while creation is in flight", async () => {
    const api = fakeSimonApi();
    const wait = deferred<{ conversationId: string }>();
    api.create.mockImplementationOnce(() => wait.promise);
    const store = new SimonStore(api, null);
    const off = store.watch(task);
    off();
    store.dispose();
    const next = store.watch(task);
    store.reopen();
    await vi.waitFor(() => expect(store.get(task).projection.view).toEqual(view));
    expect(api.create.mock.calls[0]?.[1]).toBe(api.create.mock.calls[1]?.[1]);
    wait.resolve({ conversationId: run });
    await Promise.resolve();
    expect(store.get(task).conversationId).toBe(id);
    expect(store.get(task).loading).toBe(false);
    next();
    store.dispose();
  });
  it("reopens after a disposed read already settled, without a stranded loading status", async () => {
    const api = fakeSimonApi();
    const wait = deferred<typeof view>();
    api.history.mockImplementationOnce(() => wait.promise);
    const store = new SimonStore(api, null);
    const off = store.watch(task);
    await vi.waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
    off();
    store.dispose();
    wait.resolve(view);
    await Promise.resolve();
    const next = store.watch(task);
    store.reopen();
    await vi.waitFor(() => expect(store.get(task).projection.view).toEqual(view));
    expect(store.get(task).loading).toBe(false);
    next();
  });
  it("only clears the draft after confirmed submission", async () => {
    const { api, store } = await opened();
    const wait = deferred<Awaited<ReturnType<SimonApi["send"]>>>();
    api.send.mockImplementationOnce(() => wait.promise);
    store.draft(task, "Keep until confirmed");
    const request = store.send(task);
    expect(store.get(task).draft).toBe("Keep until confirmed");
    expect(await store.send(task)).toBe(false);
    wait.resolve({ messageId: run, runId: run, status: "queued" });
    expect(await request).toBe(true);
    expect(store.get(task).draft).toBe("");
    expect(api.send).toHaveBeenCalledTimes(1);
  });
  it("freezes an uncertain intent and retries the exact body and key", async () => {
    const { api, store } = await opened();
    api.send.mockRejectedValueOnce(new ApiNetworkError());
    store.draft(task, "Original request");
    expect(await store.send(task)).toBe(false);
    expect(store.get(task)).toMatchObject({ uncertain: true, draft: "Original request" });
    store.draft(task, "Changed request");
    store.tier(task, "smart");
    expect(store.get(task)).toMatchObject({ draft: "Original request", tier: "fast" });
    expect(await store.retryRequest(task)).toBe(true);
    expect(api.send.mock.calls[0]).toEqual(api.send.mock.calls[1]);
    expect(store.get(task).draft).toBe("");
  });
  it("allows editing after a definitive validation refusal", async () => {
    const { api, store } = await opened();
    api.send.mockRejectedValueOnce(
      new ApiError({ status: 422, code: "validation", message: "invalid", requestId: run }),
    );
    store.draft(task, "Original");
    await store.send(task);
    store.draft(task, "Corrected");
    expect(store.get(task)).toMatchObject({ draft: "Corrected", uncertain: false });
  });
  it("does not discard an uncertain mutation after cleanup; remount retries its key", async () => {
    const { api, store, off } = await opened();
    const wait = deferred<Awaited<ReturnType<SimonApi["send"]>>>();
    api.send.mockImplementationOnce(() => wait.promise);
    store.draft(task, "Pending request");
    const sent = store.send(task);
    off();
    store.dispose();
    wait.resolve({ messageId: run, runId: run, status: "accepted" });
    await sent;
    const next = store.watch(task);
    store.reopen();
    await vi.waitFor(() => expect(store.get(task).projection.view).toEqual(view));
    expect(store.get(task)).toMatchObject({
      busy: false,
      uncertain: true,
      draft: "Pending request",
    });
    await store.retryRequest(task);
    expect(api.send.mock.calls[0]).toEqual(api.send.mock.calls[1]);
    next();
  });
  it("catches synchronous missing-configuration failures without an unhandled effect", async () => {
    const api = fakeSimonApi();
    api.create.mockImplementation(() => {
      throw new Error("not configured");
    });
    const store = new SimonStore(api, null);
    store.watch(task);
    await vi.waitFor(() => expect(store.get(task).error).toBeTruthy());
    expect(store.get(task).loading).toBe(false);
  });
  it("never answers an approval through an ordinary chat message", async () => {
    const { api, store } = await opened();
    store.draft(task, "Yes, approve it");
    await store.send(task);
    expect(api.send).toHaveBeenCalledOnce();
    expect(api.decide).not.toHaveBeenCalled();
  });
  it("drops loaded content after a fresh not-found denial", async () => {
    const { api, store } = await opened();
    api.history.mockRejectedValueOnce(
      new ApiError({ status: 404, code: "not_found", message: "not found", requestId: run }),
    );
    await store.load(task);
    expect(store.get(task)).toMatchObject({
      projection: { view: null },
      approval: null,
      ask: null,
    });
    store.draft(task, "Do not submit after access is revoked");
    expect(await store.send(task)).toBe(false);
    expect(api.send).not.toHaveBeenCalled();
  });
  it("does not turn an answer into an ordinary message while its question is loading", async () => {
    const api = fakeSimonApi();
    api.history.mockResolvedValue({ ...view, pendingAskId: run });
    const waiting = deferred<Awaited<ReturnType<SimonApi["ask"]>>>();
    api.ask.mockImplementation(() => waiting.promise);
    const store = new SimonStore(api, null);
    store.watch(task);
    await vi.waitFor(() => expect(api.ask).toHaveBeenCalledOnce());
    store.draft(task, "My answer");
    expect(await store.send(task)).toBe(false);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.answer).not.toHaveBeenCalled();
    store.dispose();
  });
  it("resolves a lost quick creation with its original key before closing", async () => {
    const api = fakeSimonApi();
    api.create.mockRejectedValueOnce(new ApiNetworkError());
    const store = new SimonStore(api, null);
    store.watch(null);
    await vi.waitFor(() => expect(store.get(null).error).toBeTruthy());
    const closed = vi.fn();
    expect(await store.closeQuick(closed)).toBe(true);
    expect(api.create.mock.calls[0]).toEqual(api.create.mock.calls[1]);
    expect(api.close.mock.calls[0]?.[0]).toBe(id);
    expect(closed).toHaveBeenCalledOnce();
    expect(store.get(null).conversationId).toBeNull();
    expect(api.create).toHaveBeenCalledTimes(2);
  });
  it("prepends an older page once and retains it across a live-head refresh", async () => {
    const api = fakeSimonApi();
    const recent = {
      ...view,
      messages: [
        {
          id: run,
          seq: 51,
          role: "assistant" as const,
          status: "accepted" as const,
          runId: run,
          text: "Recent",
          parts: [],
        },
      ],
      nextBeforeSeq: 51,
    };
    const oldId = "01995000-0000-7000-8000-000000000004";
    const older = {
      ...view,
      messages: [
        {
          id: oldId,
          seq: 1,
          role: "user" as const,
          status: "accepted" as const,
          runId: null,
          text: "Old",
          parts: [],
        },
      ],
      nextBeforeSeq: null,
    };
    api.history
      .mockResolvedValueOnce(recent)
      .mockResolvedValueOnce(older)
      .mockResolvedValueOnce(recent);
    const store = new SimonStore(api, null);
    store.watch(task);
    await vi.waitFor(() => expect(store.get(task).projection.view?.nextBeforeSeq).toBe(51));
    await store.loadOlder(task);
    expect(api.history.mock.calls[1]).toEqual([id, 51]);
    expect(store.get(task).projection.view?.messages.map((message) => message.text)).toEqual([
      "Old",
      "Recent",
    ]);
    await store.load(task);
    expect(store.get(task).projection.view?.messages.map((message) => message.text)).toEqual([
      "Old",
      "Recent",
    ]);
    expect(store.get(task).projection.view?.nextBeforeSeq).toBeNull();
  });
  it("drops an older-page response after the conversation is released", async () => {
    const api = fakeSimonApi();
    api.history.mockResolvedValueOnce({ ...view, nextBeforeSeq: 4 });
    const waiting = deferred<typeof view>();
    api.history.mockImplementationOnce(() => waiting.promise);
    const store = new SimonStore(api, null);
    const off = store.watch(task);
    await vi.waitFor(() => expect(store.get(task).projection.view?.nextBeforeSeq).toBe(4));
    const loading = store.loadOlder(task);
    off();
    waiting.resolve(view);
    await loading;
    expect(store.get(task)).toMatchObject({
      projection: { view: null },
      loadingOlder: false,
    });
  });
});
