import { readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InboundRelayFrame } from "../src/relay/protocol.js";
import {
  JournalCapacityError,
  JournalError,
  RelayJournal,
  type RelayJournalOptions,
  type DeliveryRecord,
  type ReplayEntryInput,
  type RelayFrame,
  type SessionBinding,
} from "../src/relay/journal.js";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const fingerprint = (value = "a") => `sha256:${value.repeat(43)}`;

type ActivityFrame = Extract<RelayFrame, { type: "activity" }>;
type DeliveryStatusFrame = Extract<RelayFrame, { type: "delivery.status" }>;
type RpcFrame = Extract<RelayFrame, { type: "rpc.request" }>;
type DeliveryAcknowledgementFrame = Extract<InboundRelayFrame, { type: "delivery.ack" }>;
type RpcResultFrame = Extract<InboundRelayFrame, { type: "rpc.result" }>;

function frame(id: number, type?: "activity"): ActivityFrame;
function frame(id: number, type: "rpc.request"): RpcFrame;
function frame(id: number, type: "activity" | "rpc.request" = "activity"): ActivityFrame | RpcFrame {
  return {
  v: 1,
  id: uuid(id),
  type,
  agentId: "agent",
  timestamp: "2026-08-12T12:00:00.000Z",
  ...(type === "rpc.request" ? { correlationId: uuid(1_000 + id), idempotencyKey: `request-${id}` } : {
    sessionId: "linear-session",
    idempotencyKey: `activity-${id}`,
  }),
  payload: type === "activity"
    ? { commandId: uuid(2_000 + id), activity: { type: "thought", body: "private body" } }
    : { method: "linear.graphql", params: { contextId: "context-1", document: "query Viewer { viewer { id } }", variables: {} } },
  } as ActivityFrame | RpcFrame;
}

function statusFrame(
  id: number,
  deliveryId: string,
  status: DeliveryStatusFrame["payload"]["status"],
  summary?: string,
): DeliveryStatusFrame {
  return {
    v: 1,
    id: uuid(id),
    type: "delivery.status",
    agentId: "agent",
    timestamp: "2026-08-12T12:00:00.000Z",
    sessionId: "linear-session",
    idempotencyKey: `idempotency-${deliveryId}`,
    payload: { deliveryId, status, ...(summary === undefined ? {} : { summary }) },
  };
}

function acknowledgementFrame(
  id: number,
  deliveryId: string,
  status: DeliveryAcknowledgementFrame["payload"]["status"],
): DeliveryAcknowledgementFrame {
  return {
    v: 1,
    id: uuid(id),
    type: "delivery.ack",
    agentId: "agent",
    timestamp: "2026-08-12T12:00:01.000Z",
    sessionId: "linear-session",
    idempotencyKey: `idempotency-${deliveryId}`,
    payload: { deliveryId, status },
  };
}

function terminalStatus(id: number, deliveryId: string, sessionId: string): DeliveryStatusFrame {
  return { ...statusFrame(id, deliveryId, "completed"), sessionId };
}

function terminalAcknowledgement(id: number, deliveryId: string, sessionId: string): DeliveryAcknowledgementFrame {
  return { ...acknowledgementFrame(id, deliveryId, "completed"), sessionId };
}

function resultFrame(
  request: RpcFrame,
  payload: RpcResultFrame["payload"] = { ok: true, result: { data: { viewer: { id: "me" } } } },
): RpcResultFrame {
  return {
    v: 1,
    id: uuid(8_000),
    type: "rpc.result",
    agentId: request.agentId,
    timestamp: "2026-08-12T12:00:01.000Z",
    correlationId: request.correlationId,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    payload,
  };
}

const binding = (sessionId = "linear-session"): SessionBinding => ({
  linearSessionId: sessionId,
  teamId: "linear-team",
  openclawSessionId: "openclaw-session",
  sessionTarget: {
    agentId: "default",
    sessionId: "openclaw-session",
    sessionKey: "agent:default:linear:linear-session",
    storePath: "/private/openclaw/sessions.json",
  },
  routing: {
    agentId: "default",
    channel: "unblock-linear",
    accountId: "default",
    sessionKey: "agent:default:linear:linear-session",
    mainSessionKey: "agent:default:main",
    lastRoutePolicy: "session",
    matchedBy: "default",
  },
  createdAt: "2026-08-12T12:00:00.000Z",
});

const delivery = (id = "delivery-1"): DeliveryRecord => ({
  deliveryId: id,
  sessionId: "linear-session",
  teamId: "linear-team",
  idempotencyKey: `idempotency-${id}`,
  action: "created",
  sequence: 1,
  prompt: "private prompt",
  status: "offered",
  terminalAcknowledged: false,
  toolRecovery: { state: "none", reconciliationRequired: false },
  recordedAt: "2026-08-12T12:00:00.000Z",
});

async function journalFixture(options: RelayJournalOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "unblock-linear-journal-"));
  const path = join(directory, "relay.json");
  return { directory, path, journal: await RelayJournal.open(path, options) };
}

describe("RelayJournal", () => {
  it("atomically persists and reloads the complete v1 state with restrictive permissions", async () => {
    const { path, journal } = await journalFixture();
    await journal.setLifecycle("enrollment_replaced", 2, {
      agentId: "agent",
      enrollmentGeneration: 1,
    });
    await journal.bindSession(binding());
    await journal.recordDelivery(delivery());
    await journal.addReplay({ key: "activity-1", kind: "activity", deliveryId: "delivery-1", frame: frame(1) });
    await journal.recordUpload({ uploadId: "upload-1", ownerId: "delivery-1", fileRef: "media://inbound/opaque", status: "uploading", graphqlCorrelationId: "corr", recordedAt: "2026-08-12T12:00:00.000Z" });

    const reloaded = await RelayJournal.open(path);
    expect(reloaded.snapshot()).toMatchObject({ lifecycle: { fence: "enrollment_replaced", generation: 2 }, replay: [{ key: "activity-1" }] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(readFile(`${path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically validates replay and RPC identities before clearing the fence", async () => {
    const { path, journal } = await journalFixture();
    const request = frame(10, "rpc.request");
    await journal.recordRpcInvocation("tool-call", fingerprint(), request);
    await journal.recordRpcResult(resultFrame(request));
    await journal.addReplay({ key: "activity", kind: "activity", deliveryId: "delivery-1", frame: frame(11) });
    await journal.setLifecycle("enrollment_replaced", 2, {
      agentId: "agent",
      enrollmentGeneration: 1,
    });

    await journal.activateReplacement({
      agentId: "agent",
      enrollmentGeneration: 2,
    });

    const reloaded = await RelayJournal.open(path);
    expect(reloaded.getLifecycle()).toEqual({ fence: "normal" });
  });

  it("rejects cross-agent replacement activation without changing fenced state", async () => {
    const { journal } = await journalFixture();
    await journal.addReplay({ key: "activity", kind: "activity", deliveryId: "delivery-1", frame: frame(1) });
    await journal.setLifecycle("enrollment_replaced", 2, {
      agentId: "agent",
      enrollmentGeneration: 1,
    });
    const before = journal.snapshot();

    await expect(journal.activateReplacement({
      agentId: "other-agent",
      enrollmentGeneration: 2,
    })).rejects.toBeInstanceOf(JournalError);
    expect(journal.snapshot()).toEqual(before);
  });

  it.each([1, 0])("rejects replacement generation %s without changing a revoked fence", async (generation) => {
    const { journal } = await journalFixture();
    const enrollment = { agentId: "agent", enrollmentGeneration: 1 };
    await journal.setLifecycle("revoked", enrollment);
    const before = journal.snapshot();

    await expect(journal.activateReplacement({
      agentId: "agent",
      enrollmentGeneration: generation,
    })).rejects.toBeInstanceOf(JournalError);
    expect(journal.snapshot()).toEqual(before);
  });

  it("keeps the primary authoritative and discards stale or corrupt temporary state", async () => {
    const { path, journal } = await journalFixture();
    await journal.bindSession(binding());
    await journal.addReplay({ key: "activity-1", kind: "activity", deliveryId: "delivery-1", frame: frame(1) });
    const stale = JSON.parse(await readFile(path, "utf8")) as { replay: unknown[] };
    stale.replay = [];
    await writeFile(`${path}.tmp`, JSON.stringify(stale), { mode: 0o600 });
    expect((await RelayJournal.open(path)).getBinding("linear-session")).toEqual(binding());
    expect((await RelayJournal.open(path)).getReplayEntries()).toHaveLength(1);
    await expect(readFile(`${path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(`${path}.tmp`, "not-json", { mode: 0o600 });
    expect((await RelayJournal.open(path)).getBinding("linear-session")).toEqual(binding());
    await expect(readFile(`${path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a complete first-write temporary file when the primary is absent", async () => {
    const { directory, path, journal } = await journalFixture();
    await journal.addReplay({ key: "activity-1", kind: "activity", deliveryId: "delivery-1", frame: frame(1) });
    const recoveredPath = join(directory, "recovered.json");
    await writeFile(`${recoveredPath}.tmp`, await readFile(path), { mode: 0o600 });

    const recovered = await RelayJournal.open(recoveredPath);
    expect(recovered.getReplayEntries()).toEqual(journal.getReplayEntries());
    expect(await readFile(recoveredPath, "utf8")).toContain("activity-1");
    await expect(readFile(`${recoveredPath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails corrupt when only an invalid first-write temporary file exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unblock-linear-journal-"));
    const path = join(directory, "relay.json");
    await writeFile(`${path}.tmp`, "not-json", { mode: 0o600 });

    await expect(RelayJournal.open(path)).rejects.toMatchObject({ message: "Journal state is corrupt" });
    expect(await readFile(`${path}.tmp`, "utf8")).toBe("not-json");
  });

  it("rejects corrupt primary state without exposing content", async () => {
    const { path } = await journalFixture();
    await writeFile(path, JSON.stringify({ version: 1, prompt: "secret prompt" }));
    await expect(RelayJournal.open(path)).rejects.toMatchObject({ message: "Journal state is corrupt" });
    await expect(RelayJournal.open(path)).rejects.not.toThrow("secret");
  });

  it("rejects replay state whose next sequence does not advance past persisted entries", async () => {
    const { path, journal } = await journalFixture();
    await journal.addReplay({ key: "activity-1", kind: "activity", deliveryId: "delivery-1", frame: frame(1) });
    const persisted = JSON.parse(await readFile(path, "utf8")) as { nextSequence: number };
    persisted.nextSequence = 1;
    await writeFile(path, JSON.stringify(persisted), { mode: 0o600 });

    await expect(RelayJournal.open(path)).rejects.toMatchObject({ message: "Journal state is corrupt" });
  });

  it("rejects a stopped-session marker without a retained delivery", async () => {
    const { path } = await journalFixture();
    const persisted = JSON.parse(await readFile(path, "utf8")) as { stoppedSessions: Record<string, string> };
    persisted.stoppedSessions["orphaned-session"] = "2026-08-12T12:00:01.000Z";
    await writeFile(path, JSON.stringify(persisted), { mode: 0o600 });

    await expect(RelayJournal.open(path)).rejects.toMatchObject({ message: "Journal state is corrupt" });
  });

  it("keeps exact replay insertion order and is idempotent for the same frame", async () => {
    const { journal } = await journalFixture();
    const first = await journal.addReplay({ key: "rpc-1", kind: "rpc", frame: frame(1, "rpc.request") });
    const second = await journal.addReplay({ key: "activity-1", kind: "activity", deliveryId: "delivery-1", frame: frame(2) });
    expect(journal.getReplayEntries().map((entry) => entry.key)).toEqual(["rpc-1", "activity-1"]);
    expect(first.ownerId).toBe("context-1");
    expect(second).toMatchObject({ ownerId: "delivery-1", sessionId: "linear-session" });
    await expect(journal.addReplay({ key: "rpc-1", kind: "rpc", frame: frame(1, "rpc.request") })).resolves.toEqual(first);
    await expect(journal.addReplay({ key: "rpc-1", kind: "rpc", deliveryId: "different-delivery", frame: frame(1, "rpc.request") })).rejects.toBeInstanceOf(JournalError);
    expect(second.sequence).toBeGreaterThan(first.sequence);
  });

  it("durably retains an exact correlated RPC request and result through restart until consumption", async () => {
    const { path, journal } = await journalFixture();
    const request = frame(10, "rpc.request");
    await journal.recordRpcInvocation("tool-call-1", fingerprint(), request);
    const result = resultFrame(request, {
      ok: true,
      result: { data: { issue: null }, errors: [{ message: "partial" }] },
    });
    await journal.recordRpcResult(result);
    await journal.removeReplay(`rpc:${request.correlationId}`);

    const recovered = await RelayJournal.open(path);
    expect(recovered.getRpcInvocation("tool-call-1")).toEqual({
      invocationId: "tool-call-1",
      semanticFingerprint: fingerprint(),
      request,
      result,
    });
    await recovered.consumeRpcInvocation("tool-call-1");
    expect(recovered.getRpcInvocation("tool-call-1")).toBeUndefined();
    expect(recovered.getReplayEntries()).toEqual([]);
  });

  it("rejects uncorrelated RPC results and requeues retryable requests with exact identity", async () => {
    const { journal } = await journalFixture();
    const request = frame(11, "rpc.request");
    await journal.recordRpcInvocation("tool-call-2", fingerprint(), request);
    await expect(journal.recordRpcResult({
      ...resultFrame(request),
      correlationId: uuid(9_999),
    })).rejects.toBeInstanceOf(JournalError);

    const retryable = resultFrame(request, {
      ok: false,
      error: { code: "retryable", message: "private", retryable: true },
    });
    await journal.recordRpcResult(retryable);
    await journal.removeReplay(`rpc:${request.correlationId}`);
    await journal.retryRpcInvocation("tool-call-2");
    expect(journal.getRpcInvocation("tool-call-2")).toEqual({
      invocationId: "tool-call-2",
      semanticFingerprint: fingerprint(),
      request,
    });
    expect(journal.getReplayEntries()).toHaveLength(1);
    expect(journal.getReplayEntries()[0]?.frame).toEqual(request);
  });

  it("retains exact delivery status through acknowledgement and preserves RPCs during compaction", async () => {
    const deliveryId = uuid(5_000);
    const { path, journal } = await journalFixture();
    await journal.bindSession(binding());
    await journal.recordDelivery({ ...delivery(deliveryId), status: "completed" });
    await journal.addReplay({ key: "activity-1", kind: "activity", deliveryId, frame: frame(1) });
    const rpc = { ...frame(2, "rpc.request"), sessionId: "linear-session" } satisfies RpcFrame;
    await journal.addReplay({ key: "rpc-1", kind: "rpc", deliveryId, frame: rpc });
    const status = statusFrame(3, deliveryId, "completed", "exact private summary");
    await journal.addReplay({ key: "status-1", kind: "delivery_status", frame: status });

    const reloaded = await RelayJournal.open(path);
    expect(reloaded.getReplayEntries(deliveryId).find((entry) => entry.kind === "delivery_status")?.frame)
      .toEqual(status);
    await expect(reloaded.acknowledgeDeliveryStatus(acknowledgementFrame(4, deliveryId, "started")))
      .rejects.toBeInstanceOf(JournalError);
    expect(reloaded.getReplayEntries(deliveryId).some((entry) => entry.kind === "delivery_status")).toBe(true);

    await reloaded.acknowledgeDeliveryStatus(acknowledgementFrame(5, deliveryId, "completed"));
    expect(reloaded.getReplayEntries().map((entry) => entry.kind)).toEqual(["activity", "rpc"]);
    expect(reloaded.getDelivery(deliveryId)).toMatchObject({ status: "completed", terminalAcknowledged: true });

    await reloaded.compactAcknowledgedDelivery(deliveryId);
    expect(reloaded.getReplayEntries().map((entry) => entry.kind)).toEqual(["rpc"]);
    await expect(reloaded.acknowledgeDeliveryStatus(
      acknowledgementFrame(6, deliveryId, "completed"),
    )).resolves.toBeUndefined();
    await reloaded.compactStoppedSession("linear-session");
    expect(reloaded.getReplayEntries().map((entry) => entry.kind)).toEqual(["rpc"]);
    await reloaded.removeCanceledSessionRpcs("linear-session");
    expect(reloaded.getReplayEntries()).toEqual([]);
  });

  it("cancels every RPC invocation and replay while retaining unrelated work", async () => {
    const { journal } = await journalFixture();
    const outsideSession = frame(20, "rpc.request");
    const inSession = { ...frame(21, "rpc.request"), sessionId: "linear-session" } satisfies RpcFrame;
    await journal.recordRpcInvocation("outside", fingerprint("b"), outsideSession);
    await journal.recordRpcInvocation("inside", fingerprint("c"), inSession, "delivery-1");
    await journal.recordRpcResult(resultFrame(outsideSession));
    await journal.removeReplay(`rpc:${outsideSession.correlationId}`);
    await journal.addReplay({
      key: "activity-kept",
      kind: "activity",
      deliveryId: "delivery-1",
      frame: frame(22),
    });

    await journal.cancelAllRpcInvocations();

    expect(journal.getRpcInvocation("outside")).toBeUndefined();
    expect(journal.getRpcInvocation("inside")).toBeUndefined();
    expect(journal.getReplayEntries().map((entry) => entry.key)).toEqual(["activity-kept"]);
  });

  it("rejects invalid protocol frames and RPCs over the persisted-request bound", async () => {
    const { journal } = await journalFixture();
    const invalidFrame = {
      ...frame(1),
      id: "not-a-uuid",
    };
    await expect(journal.addReplay({
      key: "invalid",
      kind: "activity",
      deliveryId: "delivery-1",
      frame: invalidFrame,
    } as unknown as ReplayEntryInput)).rejects.toBeInstanceOf(JournalError);

    const oversized = frame(2, "rpc.request") as Extract<RelayFrame, { type: "rpc.request" }>;
    if (oversized.payload.method !== "linear.graphql") throw new Error("Expected GraphQL frame");
    oversized.payload.params.variables = { padding: "x".repeat(61 * 1024) };
    await expect(journal.addReplay({ key: "oversized", kind: "rpc", frame: oversized }))
      .rejects.toBeInstanceOf(JournalError);
  });

  it("rejects mismatched session targets and runtime attempts to patch immutable identity", async () => {
    const { journal } = await journalFixture();
    await expect(journal.bindSession({
      ...binding(),
      openclawSessionId: "different-openclaw-session",
    })).rejects.toBeInstanceOf(JournalError);

    await journal.recordDelivery(delivery());
    await expect(journal.updateDelivery(
      "delivery-1",
      { sessionId: "different-linear-session" } as never,
    )).rejects.toBeInstanceOf(JournalError);

    await journal.recordUpload({
      uploadId: "upload-1",
      ownerId: "context-1",
      fileRef: "media://inbound/opaque",
      status: "pending",
      recordedAt: "2026-08-12T12:00:00.000Z",
    });
    await expect(journal.updateUpload(
      "upload-1",
      { fileRef: "media://inbound/different" } as never,
    )).rejects.toBeInstanceOf(JournalError);
  });

  it("fails closed at entry capacity and never evicts unresolved work", async () => {
    const { journal } = await journalFixture({ maxEntries: 2 });
    await journal.addReplay({ key: "activity-1", kind: "activity", deliveryId: "delivery-1", frame: frame(1) });
    await expect(journal.addReplay({ key: "activity-2", kind: "activity", deliveryId: "delivery-1", frame: frame(2) })).rejects.toBeInstanceOf(JournalCapacityError);
    expect(journal.getReplayEntries().map((entry) => entry.key)).toEqual(["activity-1"]);
  });

  it("fails closed at aggregate byte capacity without putting sensitive values in the error", async () => {
    const { journal } = await journalFixture({ maxBytes: 300 });
    await expect(journal.recordDelivery({ ...delivery(), prompt: "sensitive prompt that must never appear in errors" })).rejects.toBeInstanceOf(JournalCapacityError);
    try {
      await journal.recordDelivery({ ...delivery(), prompt: "sensitive prompt that must never appear in errors" });
    } catch (error) {
      expect(error).toBeInstanceOf(JournalError);
      expect(String(error)).not.toContain("sensitive prompt");
    }
    expect(journal.getDelivery("delivery-1")).toBeUndefined();
  });

  it("persists the stopped-session overlay beyond byte capacity and compacts it after reload", async () => {
    const { path, journal } = await journalFixture();
    const deliveryId = uuid(3_000);
    await journal.recordDelivery({ ...delivery(deliveryId), status: "started" });
    const ordinarySize = Buffer.byteLength(await readFile(path, "utf8"));
    const bounded = await RelayJournal.open(path, { maxBytes: ordinarySize });

    await bounded.markSessionStopped("linear-session", "2026-08-12T12:00:01.000Z");
    expect(Buffer.byteLength(await readFile(path, "utf8"))).toBeGreaterThan(ordinarySize);

    const reloaded = await RelayJournal.open(path, { maxBytes: ordinarySize });
    expect(reloaded.snapshot().stoppedSessions).toEqual({
      "linear-session": "2026-08-12T12:00:01.000Z",
    });
    await reloaded.acknowledgeAndCompactDeliveryStatus(
      acknowledgementFrame(3_001, deliveryId, "canceled"),
    );
    expect(reloaded.getDelivery(deliveryId)).toBeUndefined();
    expect(reloaded.snapshot().stoppedSessions).toEqual({});
  });

  it("bounds multiple idempotent stop markers by retained deliveries", async () => {
    const { path, journal } = await journalFixture({ maxEntries: 3 });
    await journal.recordDelivery({ ...delivery("delivery-a"), sessionId: "session-a" });
    await journal.recordDelivery({ ...delivery("delivery-b"), sessionId: "session-b" });

    await journal.markSessionStopped("session-a", "2026-08-12T12:00:01.000Z");
    await journal.markSessionStopped("session-a", "2026-08-12T12:00:02.000Z");
    await journal.markSessionStopped("session-b", "2026-08-12T12:00:03.000Z");

    const reloaded = await RelayJournal.open(path, { maxEntries: 3 });
    expect(reloaded.snapshot().stoppedSessions).toEqual({
      "session-a": "2026-08-12T12:00:01.000Z",
      "session-b": "2026-08-12T12:00:03.000Z",
    });
  });

  it("compacts only acknowledged terminal deliveries, completed uploads, and stopped sessions", async () => {
    const { journal } = await journalFixture();
    await journal.bindSession(binding());
    await journal.recordDelivery(delivery());
    await journal.addReplay({ key: "activity-1", kind: "activity", deliveryId: "delivery-1", frame: frame(1) });
    await expect(journal.compactAcknowledgedDelivery("delivery-1")).rejects.toBeInstanceOf(JournalError);
    await journal.updateDelivery("delivery-1", { status: "completed", terminalAcknowledged: true });
    await journal.compactAcknowledgedDelivery("delivery-1");
    expect(journal.getDelivery("delivery-1")).toBeUndefined();
    expect(journal.getReplayEntries()).toEqual([]);

    await journal.recordUpload({
      uploadId: "upload-1",
      ownerId: "context-1",
      fileRef: "media://inbound/opaque",
      status: "pending",
      recordedAt: "2026-08-12T12:00:00.000Z",
    });
    await expect(journal.compactCompletedUpload("upload-1")).rejects.toBeInstanceOf(JournalError);
    await journal.updateUpload("upload-1", { status: "completed", assetUrl: "https://uploads.linear.app/asset" });
    await journal.compactCompletedUpload("upload-1");
    expect(journal.getUpload("upload-1")).toBeUndefined();

    await journal.compactStoppedSession("linear-session");
    expect(journal.getBinding("linear-session")).toBeUndefined();
  });

  it("sustains 300 distinct successful stopped sessions without journal growth", async () => {
    const { journal } = await journalFixture();
    for (let index = 0; index < 300; index += 1) {
      const sessionId = `linear-session-${index}`;
      const deliveryId = uuid(10_000 + index);
      await journal.bindSession(binding(sessionId));
      await journal.recordDelivery({
        ...delivery(deliveryId),
        sessionId,
        status: "completed",
      });
      await journal.addReplay({
        key: `status-${deliveryId}`,
        kind: "delivery_status",
        frame: terminalStatus(20_000 + index, deliveryId, sessionId),
      });
      await journal.markSessionStopped(sessionId, "2026-08-12T12:00:01.000Z");
      await journal.acknowledgeAndCompactDeliveryStatus(
        terminalAcknowledgement(30_000 + index, deliveryId, sessionId),
      );
    }

    expect(journal.snapshot()).toMatchObject({
      bindings: {},
      deliveries: {},
      replay: [],
      rpcInvocations: {},
      uploads: {},
    });
  }, 30_000);

  it("preserves one prompted-session binding through deliveries until stop", async () => {
    const { journal } = await journalFixture();
    await journal.bindSession(binding());

    for (let index = 0; index < 2; index += 1) {
      const deliveryId = uuid(40_000 + index);
      await journal.recordDelivery({
        ...delivery(deliveryId),
        action: index === 0 ? "created" : "prompted",
        sequence: index + 1,
        status: "completed",
      });
      await journal.addReplay({
        key: `status-${deliveryId}`,
        kind: "delivery_status",
        frame: terminalStatus(50_000 + index, deliveryId, "linear-session"),
      });
      await journal.acknowledgeAndCompactDeliveryStatus(
        terminalAcknowledgement(60_000 + index, deliveryId, "linear-session"),
      );
      expect(journal.getBinding("linear-session")).toBeDefined();
    }

    expect(journal.snapshot().deliveries).toEqual({});
    await journal.markSessionStopped("linear-session", "2026-08-12T12:00:01.000Z");
    expect(journal.getBinding("linear-session")).toBeUndefined();
  });

  it("compacts a completed delivery-owned upload only after terminal acknowledgement", async () => {
    const { journal } = await journalFixture();
    await journal.bindSession(binding());

    const deliveryId = uuid(70_000);
    const uploadId = "upload-1";
    await journal.recordDelivery({ ...delivery(deliveryId), status: "completed" });
    await journal.recordUpload({
      uploadId,
      ownerId: "openclaw-session",
      deliveryId,
      sessionId: "linear-session",
      fileRef: "media://inbound/opaque",
      status: "completed",
      assetUrl: "https://uploads.linear.app/asset",
      recordedAt: "2026-08-12T12:00:00.000Z",
    });
    expect(journal.getUpload(uploadId)).toBeDefined();
    await journal.addReplay({
      key: `status-${deliveryId}`,
      kind: "delivery_status",
      frame: terminalStatus(80_000, deliveryId, "linear-session"),
    });
    expect(journal.getUpload(uploadId)).toBeDefined();
    await journal.acknowledgeAndCompactDeliveryStatus(
      terminalAcknowledgement(90_000, deliveryId, "linear-session"),
    );
    expect(journal.getUpload(uploadId)).toBeUndefined();

    expect(journal.snapshot().uploads).toEqual({});
  });

  it("persists stop before acknowledgement and finishes safe cleanup after reload", async () => {
    const { path, journal } = await journalFixture();
    const deliveryId = uuid(100_000);
    await journal.bindSession(binding());
    await journal.recordDelivery({ ...delivery(deliveryId), status: "completed" });
    await journal.recordUpload({
      uploadId: "completed-upload",
      ownerId: "openclaw-session",
      deliveryId,
      sessionId: "linear-session",
      fileRef: "media://inbound/completed",
      status: "completed",
      assetUrl: "https://uploads.linear.app/asset/completed",
      recordedAt: "2026-08-12T12:00:00.000Z",
    });
    await journal.recordUpload({
      uploadId: "ambiguous-upload",
      ownerId: "openclaw-session",
      deliveryId,
      sessionId: "linear-session",
      fileRef: "media://inbound/ambiguous",
      status: "ambiguous",
      recordedAt: "2026-08-12T12:00:00.000Z",
    });
    const request = { ...frame(100_001, "rpc.request"), sessionId: "linear-session" } satisfies RpcFrame;
    await journal.recordRpcInvocation("session-rpc", fingerprint("d"), request, deliveryId);
    await journal.addReplay({
      key: `status-${deliveryId}`,
      kind: "delivery_status",
      frame: terminalStatus(100_002, deliveryId, "linear-session"),
    });

    await journal.markSessionStopped("linear-session", "2026-08-12T12:00:01.000Z");
    const reloaded = await RelayJournal.open(path);
    expect(reloaded.snapshot().stoppedSessions["linear-session"]).toBe("2026-08-12T12:00:01.000Z");
    expect(reloaded.getRpcInvocation("session-rpc")).toBeUndefined();
    expect(reloaded.getUpload("completed-upload")).toBeDefined();

    await reloaded.acknowledgeAndCompactDeliveryStatus(
      terminalAcknowledgement(100_003, deliveryId, "linear-session"),
    );
    expect(reloaded.getBinding("linear-session")).toBeUndefined();
    expect(reloaded.getUpload("completed-upload")).toBeUndefined();
    expect(reloaded.getUpload("ambiguous-upload")?.status).toBe("ambiguous");
  });

  it("keeps an immediate stop durable while a created delivery is waiting to bind", async () => {
    const { path, journal } = await journalFixture();
    const deliveryId = uuid(100_010);
    await journal.recordDelivery(delivery(deliveryId));

    await journal.markSessionStopped("linear-session", "2026-08-12T12:00:01.000Z");
    await journal.bindSession(binding());

    const reloaded = await RelayJournal.open(path);
    expect(reloaded.snapshot().stoppedSessions).toEqual({
      "linear-session": "2026-08-12T12:00:01.000Z",
    });
    expect(reloaded.getBinding("linear-session")).toBeDefined();
  });

  it("accepts the Worker's canceled acknowledgement after a stopped-session crash", async () => {
    const { path, journal } = await journalFixture();
    const deliveryId = uuid(100_020);
    await journal.recordDelivery({ ...delivery(deliveryId), status: "started" });
    await journal.bindSession(binding());
    await journal.markSessionStopped("linear-session", "2026-08-12T12:00:01.000Z");

    const reloaded = await RelayJournal.open(path);
    await expect(reloaded.acknowledgeAndCompactDeliveryStatus(
      acknowledgementFrame(100_021, deliveryId, "canceled"),
    )).resolves.toBeUndefined();
    expect(reloaded.getDelivery(deliveryId)).toBeUndefined();
    expect(reloaded.getBinding("linear-session")).toBeUndefined();
    expect(reloaded.snapshot().stoppedSessions).toEqual({});
  });

  it("still rejects a canceled acknowledgement without a stopped-session marker", async () => {
    const { journal } = await journalFixture();
    const deliveryId = uuid(100_030);
    await journal.recordDelivery({ ...delivery(deliveryId), status: "started" });

    await expect(journal.acknowledgeAndCompactDeliveryStatus(
      acknowledgementFrame(100_031, deliveryId, "canceled"),
    )).rejects.toBeInstanceOf(JournalError);
    expect(journal.getDelivery(deliveryId)?.status).toBe("started");
  });

  it("retains unresolved activity, RPC, pending, and ambiguous work when capacity fails closed", async () => {
    const { journal } = await journalFixture({ maxEntries: 8 });
    await journal.bindSession(binding());
    await journal.recordDelivery(delivery());
    await journal.addReplay({ key: "activity-unresolved", kind: "activity", deliveryId: "delivery-1", frame: frame(110_000) });
    const request = { ...frame(110_001, "rpc.request"), sessionId: "linear-session" } satisfies RpcFrame;
    await journal.recordRpcInvocation("unresolved-rpc", fingerprint("e"), request, "delivery-1");
    await journal.recordUpload({
      uploadId: "pending-upload",
      ownerId: "openclaw-session",
      deliveryId: "delivery-1",
      sessionId: "linear-session",
      fileRef: "media://inbound/pending",
      status: "pending",
      recordedAt: "2026-08-12T12:00:00.000Z",
    });
    await journal.recordUpload({
      uploadId: "ambiguous-upload",
      ownerId: "openclaw-session",
      deliveryId: "delivery-1",
      sessionId: "linear-session",
      fileRef: "media://inbound/ambiguous",
      status: "ambiguous",
      recordedAt: "2026-08-12T12:00:00.000Z",
    });

    await expect(journal.recordUpload({
      uploadId: "overflow",
      ownerId: "generic-context",
      fileRef: "media://inbound/overflow",
      status: "pending",
      recordedAt: "2026-08-12T12:00:00.000Z",
    })).rejects.toBeInstanceOf(JournalCapacityError);
    expect(journal.getReplayEntries().map((entry) => entry.kind)).toEqual(["activity", "rpc"]);
    expect(journal.getRpcInvocation("unresolved-rpc")).toBeDefined();
    expect(journal.getUpload("pending-upload")?.status).toBe("pending");
    expect(journal.getUpload("ambiguous-upload")?.status).toBe("ambiguous");
  });
});
