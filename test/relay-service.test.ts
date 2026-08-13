import { mkdir, mkdtemp, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type DeviceAuthUpgradeInput } from "../src/relay/device-auth.js";
import { RelayJournal, type RelayJournalOptions } from "../src/relay/journal.js";
import { parseInboundRelayFrame, parseOutboundRelayFrame } from "../src/relay/protocol.js";
import { acquireRelayWriterLease, RelayLeaseError } from "../src/relay/lease.js";
import { RelayService, type RelaySocket, type RelayTimer } from "../src/relay/service.js";

const account: DeviceAuthUpgradeInput = {
  origin: "https://linear-staging.unblocklabs.ai",
  agentId: "agent-1",
  deviceId: "device-1",
  enrollmentGeneration: 1,
  privateKeyJwk: {
    kty: "EC",
    crv: "P-256",
    x: "z8ji77cSxUiWOdGk8KCSV0p1jLBJl4zgEDOj6R4DtMA",
    y: "ONa1i6bQCT76I1gwX_nxsJQnQss31Pkf8AAUP3RqAA0",
    d: "-Cn-hKIQXIuHi07HA0WnkgcZD_G5-1hOeR-ETgpKZDU",
  },
};

const base = {
  v: 1 as const,
  agentId: account.agentId,
  deviceId: account.deviceId,
  timestamp: "2026-08-12T12:00:00.000Z",
};

class FakeSocket {
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, listener: (...args: never[]) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.emit("close", code ?? 1000, "");
  }

  open(): void {
    this.emit("open");
  }

  message(data: string | ArrayBuffer): void {
    this.emit("message", data);
  }

  unexpectedResponse(statusCode: number, body?: string): void {
    this.emit("unexpected-response", { statusCode, ...(body === undefined ? {} : { body }) });
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }
}

class NeverClosingSocket extends FakeSocket {
  readonly terminate = vi.fn();

  override close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
}

class FakeTimer implements RelayTimer {
  readonly scheduled: Array<{ handle: number; delayMs: number }> = [];
  private readonly callbacks = new Map<number, () => void>();
  private nextHandle = 1;

  setTimeout(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    this.scheduled.push({ handle, delayMs });
    this.callbacks.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.callbacks.delete(handle);
  }

  fireNext(): void {
    const next = this.scheduled.find(({ handle }) => this.callbacks.has(handle));
    if (next === undefined) throw new Error("Expected a scheduled timer");
    const callback = this.callbacks.get(next.handle);
    this.callbacks.delete(next.handle);
    callback?.();
  }
}

async function createJournal(options: RelayJournalOptions = {}): Promise<{ journal: RelayJournal; journalPath: string; leasePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "unblock-linear-relay-service-"));
  const journalPath = join(directory, "journal.json");
  return {
    journal: await RelayJournal.open(journalPath, options),
    journalPath,
    leasePath: join(directory, "writer.lock"),
  };
}

function outbound(frame: Record<string, unknown>) {
  return parseOutboundRelayFrame(JSON.stringify(frame));
}

function inbound(frame: Record<string, unknown>) {
  return JSON.stringify(parseInboundRelayFrame(JSON.stringify(frame)));
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { interval: 5, timeout: 1_000 });
}

describe("RelayService", () => {
  it("terminates a shutdown socket that never closes and releases the writer lease", async () => {
    const { journal, leasePath } = await createJournal();
    const socket = new NeverClosingSocket();
    const timer = new FakeTimer();
    const service = new RelayService({
      account,
      journal,
      leasePath,
      timers: timer,
      socketFactory: () => socket as unknown as RelaySocket,
    });
    await service.start();
    socket.open();

    let stopped = false;
    const stopping = service.stop().then(() => { stopped = true; });
    await waitFor(() => expect(socket.closes).toEqual([{ code: 1000, reason: "Relay service stopped" }]));
    expect(stopped).toBe(false);
    timer.fireNext();
    await stopping;

    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(service.getState()).toBe("stopped");
    const nextLease = await acquireRelayWriterLease(leasePath);
    await nextLease.release();
  });

  it("fails closed when another process owns the writer lease", async () => {
    const { journal, leasePath } = await createJournal();
    const firstSocket = new FakeSocket();
    const first = new RelayService({ account, journal, leasePath, socketFactory: () => firstSocket as unknown as RelaySocket });
    const second = new RelayService({ account, journal, leasePath, socketFactory: () => new FakeSocket() as unknown as RelaySocket });

    expect(await first.start()).toBe(true);
    await expect(second.start()).rejects.toBeInstanceOf(RelayLeaseError);
    await first.stop();
    expect(await second.start({ oneShot: true })).toBe(true);
    await second.stop();
  });

  it("reclaims a proven-dead same-host writer lease without racing a second writer", async () => {
    const { leasePath } = await createJournal();
    await writeFile(leasePath, JSON.stringify({ v: 1, pid: 91_001, token: "dead-owner" }), { mode: 0o600 });

    const first = await acquireRelayWriterLease(leasePath, {
      pid: 91_002,
      token: "new-owner",
      isProcessAlive: () => false,
    });
    await expect(acquireRelayWriterLease(leasePath, {
      pid: 91_003,
      token: "other-owner",
      isProcessAlive: (pid) => pid === 91_002,
    })).rejects.toMatchObject({ code: "held" });
    await first.release();
  });

  it("closes oversized and stale-identity inbound frames with the protocol close codes", async () => {
    const { journal, leasePath } = await createJournal();
    const socket = new FakeSocket();
    const service = new RelayService({ account, journal, leasePath, socketFactory: () => socket as unknown as RelaySocket });
    await service.start({ oneShot: true });
    socket.open();
    socket.message("x".repeat(64 * 1024 + 1));
    await settle();
    expect(socket.closes.at(-1)).toMatchObject({ code: 1009 });

    const identitySocket = new FakeSocket();
    const identityService = new RelayService({
      account,
      journal,
      leasePath: `${leasePath}.identity`,
      socketFactory: () => identitySocket as unknown as RelaySocket,
    });
    await identityService.start({ oneShot: true });
    identitySocket.open();
    identitySocket.message(inbound({
      ...base,
      id: "10000000-0000-4000-8000-000000000001",
      type: "control",
      agentId: "other-agent",
      payload: { kind: "installation.revoked" },
    }));
    await settle();
    expect(identitySocket.closes.at(-1)).toMatchObject({ code: 1008 });
    await identityService.stop();
  });

  it("processes controls before later delivery callbacks, cancels scoped work, and consumes delivery acknowledgements", async () => {
    const { journal, leasePath } = await createJournal();
    const deliveryId = "20000000-0000-4000-8000-000000000001";
    const sessionId = "session-1";
    await journal.recordDelivery({
      deliveryId,
      sessionId,
      teamId: "team-1",
      idempotencyKey: deliveryId,
      action: "created",
      sequence: 1,
      prompt: "Work",
      status: "started",
      terminalAcknowledged: false,
      toolRecovery: { state: "none", reconciliationRequired: false },
      recordedAt: "2026-08-12T12:00:00.000Z",
    });
    const status = outbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000002",
      type: "delivery.status",
      sessionId,
      idempotencyKey: deliveryId,
      payload: { deliveryId, status: "started" },
    });
    const rpc = outbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000003",
      type: "rpc.request",
      sessionId,
      correlationId: "20000000-0000-4000-8000-000000000004",
      idempotencyKey: "rpc-1",
      payload: { method: "linear.graphql", params: { contextId: "session:session-1", document: "query { viewer { id } }", variables: {} } },
    });
    if (status.type !== "delivery.status" || rpc.type !== "rpc.request") throw new Error("Unexpected test frame type");
    await journal.addReplay({ key: "delivery-status", kind: "delivery_status", frame: status });
    await journal.addReplay({ key: "rpc", kind: "rpc", deliveryId, frame: rpc });
    const events: string[] = [];
    const socket = new FakeSocket();
    const service = new RelayService({
      account,
      journal,
      leasePath,
      socketFactory: () => socket as unknown as RelaySocket,
      callbacks: {
        onSessionStop: () => { events.push("session"); },
        onTeamAccessRemoved: () => { events.push("team"); },
        onInstallationRevoked: () => { events.push("global"); },
        onDeliveryAcknowledged: () => { events.push("ack"); },
        onDelivery: () => { events.push("delivery"); },
      },
    });
    await service.start({ oneShot: true });
    socket.open();
    socket.message(inbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000005",
      type: "control",
      sessionId,
      payload: { kind: "session.stop", reason: "Stop" },
    }));
    socket.message(inbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000006",
      type: "control",
      payload: { kind: "team.access_removed", teamId: "team-1" },
    }));
    socket.message(inbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000007",
      type: "delivery.ack",
      sessionId,
      idempotencyKey: deliveryId,
      payload: { deliveryId, status: "started" },
    }));
    socket.message(inbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000008",
      type: "delivery",
      sessionId,
      idempotencyKey: deliveryId,
      payload: {
        deliveryId,
        action: "created",
        sequence: 1,
        teamId: "team-1",
        prompt: "Work",
      },
    }));
    socket.message(inbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000009",
      type: "control",
      payload: { kind: "installation.revoked" },
    }));
    await waitFor(() => expect(events).toEqual(["session", "team", "ack", "delivery", "global"]));
    expect(journal.getReplayEntries().map((entry) => entry.key)).toEqual([]);
    expect(service.getState()).toBe("revoked");
    await service.stop();
  });

  it("persists an immediate session stop while the created delivery is paused before binding", async () => {
    const { journal, leasePath } = await createJournal();
    const socket = new FakeSocket();
    const deliveryId = "20000000-0000-4000-8000-000000000011";
    let releaseBinding: (() => void) | undefined;
    const bindingReleased = new Promise<void>((resolve) => { releaseBinding = resolve; });
    let deliveryRecorded: (() => void) | undefined;
    const recorded = new Promise<void>((resolve) => { deliveryRecorded = resolve; });
    const service = new RelayService({
      account,
      journal,
      leasePath,
      socketFactory: () => socket as unknown as RelaySocket,
      callbacks: {
        onDelivery: async (frame) => {
          await journal.recordDelivery({
            deliveryId,
            sessionId: frame.sessionId,
            teamId: "team-1",
            idempotencyKey: deliveryId,
            action: "created",
            sequence: 1,
            prompt: "Work",
            status: "offered",
            terminalAcknowledged: false,
            toolRecovery: { state: "none", reconciliationRequired: false },
            recordedAt: base.timestamp,
          });
          deliveryRecorded?.();
          await bindingReleased;
          await journal.bindSession({
            linearSessionId: frame.sessionId,
            teamId: "team-1",
            openclawSessionId: "openclaw-session",
            sessionTarget: {
              agentId: "default",
              sessionId: "openclaw-session",
              sessionKey: "agent:default:linear:session-1",
              storePath: "/private/openclaw/sessions.json",
            },
            routing: {
              agentId: "default",
              channel: "unblock-linear",
              accountId: "default",
              sessionKey: "agent:default:linear:session-1",
              mainSessionKey: "agent:default:main",
              lastRoutePolicy: "session",
              matchedBy: "default",
            },
            createdAt: base.timestamp,
          });
        },
      },
    });
    await service.start({ oneShot: true });
    socket.open();
    socket.message(inbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000012",
      type: "delivery",
      sessionId: "session-1",
      idempotencyKey: deliveryId,
      payload: { deliveryId, action: "created", sequence: 1, teamId: "team-1", prompt: "Work" },
    }));
    await recorded;
    socket.message(inbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000013",
      type: "control",
      sessionId: "session-1",
      payload: { kind: "session.stop", reason: "Stopped" },
    }));
    await waitFor(() => expect(journal.snapshot().stoppedSessions["session-1"]).toBe(base.timestamp));
    releaseBinding?.();
    await waitFor(() => expect(journal.snapshot().stoppedSessions["session-1"]).toBe(base.timestamp));
    await service.stop();
  });

  it("persists and aborts a session stop when ordinary journal entries are at capacity", async () => {
    const { journalPath, journal, leasePath } = await createJournal({ maxEntries: 2 });
    const deliveryId = "20000000-0000-4000-8000-000000000014";
    await journal.recordDelivery({
      deliveryId,
      sessionId: "session-1",
      teamId: "team-1",
      idempotencyKey: deliveryId,
      action: "created",
      sequence: 1,
      prompt: "Work",
      status: "started",
      terminalAcknowledged: false,
      toolRecovery: { state: "none", reconciliationRequired: false },
      recordedAt: base.timestamp,
    });
    const onSessionStop = vi.fn();
    const socket = new FakeSocket();
    const service = new RelayService({
      account,
      journal,
      leasePath,
      socketFactory: () => socket as unknown as RelaySocket,
      callbacks: { onSessionStop },
    });
    await service.start({ oneShot: true });
    socket.open();

    socket.message(inbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000015",
      type: "control",
      sessionId: "session-1",
      payload: { kind: "session.stop", reason: "Stopped" },
    }));
    await waitFor(() => {
      expect(onSessionStop).toHaveBeenCalledWith("session-1", "Stopped");
      expect(journal.snapshot().stoppedSessions["session-1"]).toBe(base.timestamp);
    });
    await service.stop();

    const reloaded = await RelayJournal.open(journalPath, { maxEntries: 2 });
    expect(reloaded.snapshot().stoppedSessions["session-1"]).toBe(base.timestamp);
    const acknowledgement = parseInboundRelayFrame(JSON.stringify({
      ...base,
      id: "20000000-0000-4000-8000-000000000016",
      type: "delivery.ack",
      sessionId: "session-1",
      idempotencyKey: deliveryId,
      payload: { deliveryId, status: "canceled" },
    }));
    if (acknowledgement.type !== "delivery.ack") throw new Error("Unexpected test frame type");
    await reloaded.acknowledgeAndCompactDeliveryStatus(acknowledgement);
    expect(reloaded.getDelivery(deliveryId)).toBeUndefined();
    expect(reloaded.snapshot().stoppedSessions).toEqual({});
  });

  it("aborts and fails closed when a session stop cannot be persisted", async () => {
    const { journalPath, journal, leasePath } = await createJournal();
    const deliveryId = "20000000-0000-4000-8000-000000000017";
    await journal.recordDelivery({
      deliveryId,
      sessionId: "session-1",
      teamId: "team-1",
      idempotencyKey: deliveryId,
      action: "created",
      sequence: 1,
      prompt: "Work",
      status: "started",
      terminalAcknowledged: false,
      toolRecovery: { state: "none", reconciliationRequired: false },
      recordedAt: base.timestamp,
    });
    const onSessionStop = vi.fn();
    const socket = new FakeSocket();
    const service = new RelayService({
      account,
      journal,
      leasePath,
      socketFactory: () => socket as unknown as RelaySocket,
      callbacks: { onSessionStop },
    });
    await service.start({ oneShot: true });
    socket.open();
    const blockedTemporaryPath = `${journalPath}.tmp`;
    await mkdir(blockedTemporaryPath);

    socket.message(inbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000018",
      type: "control",
      sessionId: "session-1",
      payload: { kind: "session.stop", reason: "Stopped" },
    }));
    await waitFor(() => {
      expect(onSessionStop).toHaveBeenCalledWith("session-1", "Stopped");
      expect(socket.closes.at(-1)).toEqual({ code: 1011, reason: "Relay frame processing failed" });
    });
    expect(journal.snapshot().stoppedSessions).toEqual({});

    await rmdir(blockedTemporaryPath);
    await service.stop();
  });

  it("preserves the persistence error when session stop persistence and cancellation both fail", async () => {
    const { journal, leasePath } = await createJournal();
    const persistenceError = new Error("journal unavailable");
    const cancellationError = new Error("cancellation failed");
    vi.spyOn(journal, "markSessionStopped").mockRejectedValue(persistenceError);
    const onSessionStop = vi.fn().mockRejectedValue(cancellationError);
    const socket = new FakeSocket();
    const service = new RelayService({
      account,
      journal,
      leasePath,
      socketFactory: () => socket as unknown as RelaySocket,
      callbacks: { onSessionStop },
    });
    const frame = parseInboundRelayFrame(JSON.stringify({
      ...base,
      id: "20000000-0000-4000-8000-000000000019",
      type: "control",
      sessionId: "session-1",
      payload: { kind: "session.stop", reason: "Stopped" },
    }));
    if (frame.type !== "control") throw new Error("Unexpected test frame type");

    await expect(service["handleControl"](socket as unknown as RelaySocket, frame)).rejects.toBe(persistenceError);
    expect(onSessionStop).toHaveBeenCalledWith("session-1", "Stopped");
  });

  it("accepts Worker control-then-canceled-ack ordering after a crash", async () => {
    const { journalPath, journal, leasePath } = await createJournal();
    const deliveryId = "20000000-0000-4000-8000-000000000021";
    await journal.recordDelivery({
      deliveryId,
      sessionId: "session-1",
      teamId: "team-1",
      idempotencyKey: deliveryId,
      action: "created",
      sequence: 1,
      prompt: "Work",
      status: "started",
      terminalAcknowledged: false,
      toolRecovery: { state: "none", reconciliationRequired: false },
      recordedAt: base.timestamp,
    });
    const reloaded = await RelayJournal.open(journalPath);
    const socket = new FakeSocket();
    const service = new RelayService({
      account,
      journal: reloaded,
      leasePath,
      socketFactory: () => socket as unknown as RelaySocket,
    });
    await service.start({ oneShot: true });
    socket.open();
    socket.message(inbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000022",
      type: "control",
      sessionId: "session-1",
      payload: { kind: "session.stop", reason: "Stopped" },
    }));
    socket.message(inbound({
      ...base,
      id: "20000000-0000-4000-8000-000000000023",
      type: "delivery.ack",
      sessionId: "session-1",
      idempotencyKey: deliveryId,
      payload: { deliveryId, status: "canceled" },
    }));
    await waitFor(() => expect(reloaded.getDelivery(deliveryId)).toBeUndefined());
    expect(reloaded.snapshot().stoppedSessions).toEqual({});
    expect(socket.closes).toEqual([]);
    await service.stop();
  });

  it("does not queue controls behind an admitted delivery task", async () => {
    const { journal, leasePath } = await createJournal();
    const socket = new FakeSocket();
    const events: string[] = [];
    let finishDelivery: (() => void) | undefined;
    const deliveryFinished = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    const service = new RelayService({
      account,
      journal,
      leasePath,
      socketFactory: () => socket as unknown as RelaySocket,
      callbacks: {
        onDelivery: async () => {
          events.push("delivery");
          await deliveryFinished;
        },
        onSessionStop: () => { events.push("stop"); },
      },
    });
    await service.start();
    socket.open();
    socket.message(inbound({
      ...base,
      id: "21000000-0000-4000-8000-000000000001",
      type: "delivery",
      sessionId: "session-1",
      idempotencyKey: "21000000-0000-4000-8000-000000000002",
      payload: {
        deliveryId: "21000000-0000-4000-8000-000000000002",
        action: "created",
        sequence: 1,
        teamId: "team-1",
        prompt: "Work",
      },
    }));
    await waitFor(() => expect(events).toEqual(["delivery"]));
    socket.message(inbound({
      ...base,
      id: "21000000-0000-4000-8000-000000000003",
      type: "control",
      sessionId: "session-1",
      payload: { kind: "session.stop" },
    }));
    await waitFor(() => expect(events).toEqual(["delivery", "stop"]));
    finishDelivery?.();
    await settle();
    await service.stop();
  });

  it("replays persisted frames in durable sequence and leaves RPC consumption to its owning bridge", async () => {
    const { journal, leasePath } = await createJournal();
    const activity = outbound({
      ...base,
      id: "30000000-0000-4000-8000-000000000001",
      type: "activity",
      sessionId: "session-1",
      idempotencyKey: "activity-1",
      payload: {
        commandId: "30000000-0000-4000-8000-000000000002",
        activity: { type: "thought", body: "Working" },
      },
    });
    const rpc = outbound({
      ...base,
      id: "30000000-0000-4000-8000-000000000003",
      type: "rpc.request",
      correlationId: "30000000-0000-4000-8000-000000000004",
      idempotencyKey: "rpc-1",
      payload: { method: "linear.graphql", params: { contextId: "context-1", document: "query { viewer { id } }", variables: {} } },
    });
    if (activity.type !== "activity" || rpc.type !== "rpc.request") throw new Error("Unexpected test frame type");
    await journal.addReplay({ key: "activity", kind: "activity", deliveryId: "delivery-1", frame: activity });
    await journal.addReplay({ key: "rpc", kind: "rpc", frame: rpc });
    const first = new FakeSocket();
    const second = new FakeSocket();
    const timer = new FakeTimer();
    const sockets = [first, second];
    const nonces: string[] = [];
    let consumedWithReplay = false;
    const service = new RelayService({
      account,
      journal,
      leasePath,
      timers: timer,
      random: () => 0.5,
      socketFactory: (upgrade) => {
        nonces.push(upgrade.headers["X-Relay-Nonce"]);
        const socket = sockets.shift();
        if (socket === undefined) throw new Error("Unexpected extra connection");
        return socket as unknown as RelaySocket;
      },
      callbacks: {
        onRpcResult: (_frame, replay) => {
          consumedWithReplay = replay?.key === "rpc" && journal.getReplayEntries().some((entry) => entry.key === "rpc");
        },
      },
    });
    await service.start();
    expect(await service.start()).toBe(false);
    first.open();
    expect(first.sent.map((entry) => JSON.parse(entry).type)).toEqual(["activity", "rpc.request"]);
    first.close(1006, "network");
    await settle();
    expect(service.getState()).toBe("reconnect_wait");
    expect(timer.scheduled.at(-1)?.delayMs).toBe(1_000);
    timer.fireNext();
    second.open();
    expect(new Set(nonces).size).toBe(2);
    expect(second.sent.map((entry) => JSON.parse(entry).type)).toEqual(["activity", "rpc.request"]);
    second.message(inbound({
      ...base,
      id: "30000000-0000-4000-8000-000000000005",
      type: "rpc.result",
      correlationId: "30000000-0000-4000-8000-000000000004",
      payload: { ok: true, result: { data: {} } },
    }));
    await waitFor(() => expect(consumedWithReplay).toBe(true));
    expect(journal.getReplayEntries().map((entry) => entry.key)).toEqual(["activity", "rpc"]);
    expect(consumedWithReplay).toBe(true);
    await service.stop();
  });

  it("persists and fences an explicit device replacement control", async () => {
    const { journal, leasePath } = await createJournal();
    const socket = new FakeSocket();
    const replaced: number[] = [];
    const terminal: string[] = [];
    const service = new RelayService({
      account,
      journal,
      leasePath,
      socketFactory: () => socket as unknown as RelaySocket,
      callbacks: {
        onDeviceReplaced: (generation) => { replaced.push(generation); },
        onTerminal: (reason) => { terminal.push(reason); },
      },
    });
    await service.start({ oneShot: true });
    socket.open();
    socket.message(inbound({
      ...base,
      id: "40000000-0000-4000-8000-000000000001",
      type: "control",
      payload: { kind: "device.replaced", generation: 2 },
    }));
    await waitFor(() => expect(service.getState()).toBe("device_replaced"));
    expect(journal.getLifecycle()).toEqual({
      fence: "device_replaced",
      generation: 2,
      enrollment: { agentId: "agent-1", deviceId: "device-1", enrollmentGeneration: 1 },
    });
    expect(replaced).toEqual([2]);
    expect(terminal).toEqual(["device_replaced"]);
    expect(socket.closes.at(-1)).toMatchObject({ code: 4001 });
    await service.stop();
  });

  it("fences the old enrollment when the Worker sends the new device identity then immediately closes", async () => {
    const { journal, leasePath } = await createJournal();
    const socket = new FakeSocket();
    const timer = new FakeTimer();
    const release = vi.fn(async () => undefined);
    const replaced: number[] = [];
    const service = new RelayService({
      account,
      journal,
      leasePath,
      timers: timer,
      socketFactory: () => socket as unknown as RelaySocket,
      acquireLease: vi.fn(async () => ({ release })),
      callbacks: {
        onDeviceReplaced: (generation) => { replaced.push(generation); },
      },
    });
    await service.start();
    socket.open();

    socket.message(inbound({
      ...base,
      id: "40000000-0000-4000-8000-000000000002",
      type: "control",
      deviceId: "device-2",
      payload: { kind: "device.replaced", generation: 2 },
    }));
    socket.close(4001, "Device enrollment rotated");

    await waitFor(() => expect(service.getState()).toBe("device_replaced"));
    expect(journal.getLifecycle()).toEqual({
      fence: "device_replaced",
      generation: 2,
      enrollment: { agentId: "agent-1", deviceId: "device-1", enrollmentGeneration: 1 },
    });
    expect(replaced).toEqual([2]);
    expect(timer.scheduled).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "a replacement generation that is not newer",
      frame: {
        ...base,
        id: "40000000-0000-4000-8000-000000000003",
        type: "control",
        deviceId: "device-2",
        payload: { kind: "device.replaced", generation: 1 },
      },
    },
    {
      name: "a cross-agent replacement",
      frame: {
        ...base,
        id: "40000000-0000-4000-8000-000000000004",
        type: "control",
        agentId: "other-agent",
        deviceId: "device-2",
        payload: { kind: "device.replaced", generation: 2 },
      },
    },
    {
      name: "another control kind stamped with a different device",
      frame: {
        ...base,
        id: "40000000-0000-4000-8000-000000000005",
        type: "control",
        deviceId: "device-2",
        payload: { kind: "installation.revoked" },
      },
    },
    {
      name: "a non-control frame stamped with a different device",
      frame: {
        ...base,
        id: "40000000-0000-4000-8000-000000000006",
        type: "rpc.result",
        deviceId: "device-2",
        correlationId: "40000000-0000-4000-8000-000000000007",
        payload: { ok: true, result: {} },
      },
    },
  ])("policy-closes $name without creating a replacement fence", async ({ frame }) => {
    const { journal, leasePath } = await createJournal();
    const socket = new FakeSocket();
    const service = new RelayService({
      account,
      journal,
      leasePath,
      socketFactory: () => socket as unknown as RelaySocket,
    });
    await service.start({ oneShot: true });
    socket.open();

    socket.message(inbound(frame));

    await waitFor(() => expect(socket.closes).toContainEqual({ code: 1008, reason: "Relay identity mismatch" }));
    expect(journal.getLifecycle()).toEqual({ fence: "normal" });
    await waitFor(() => expect(service.getState()).toBe("stopped"));
  });

  it("uses one awaitable signed probe on revoked startup and clears the fence only after open", async () => {
    const { journal, leasePath } = await createJournal();
    await journal.setLifecycle("revoked");
    const socket = new FakeSocket();
    let created = false;
    const service = new RelayService({
      account,
      journal,
      leasePath,
      socketFactory: () => {
        created = true;
        return socket as unknown as RelaySocket;
      },
    });

    const started = service.start();
    await waitFor(() => expect(created).toBe(true));
    expect(service.getState()).toBe("starting");
    expect(journal.getLifecycle()).toEqual({ fence: "revoked" });
    socket.open();

    await expect(started).resolves.toBe(true);
    expect(service.getState()).toBe("connected");
    expect(journal.getLifecycle()).toEqual({ fence: "normal" });
    await service.stop();
  });

  it("keeps revoked state after the one startup probe closes before open", async () => {
    const { journal, leasePath } = await createJournal();
    await journal.setLifecycle("revoked");
    const socket = new FakeSocket();
    const timer = new FakeTimer();
    const release = vi.fn(async () => undefined);
    const acquireLease = vi.fn(async () => ({ release }));
    let created = false;
    const service = new RelayService({
      account,
      journal,
      leasePath,
      timers: timer,
      acquireLease,
      socketFactory: () => {
        created = true;
        return socket as unknown as RelaySocket;
      },
    });

    const started = service.start();
    await waitFor(() => expect(created).toBe(true));
    socket.close(1006, "upgrade failed");

    await expect(started).resolves.toBe(false);
    expect(service.getState()).toBe("revoked");
    expect(journal.getLifecycle()).toEqual({ fence: "revoked" });
    expect(timer.scheduled).toEqual([]);
    expect(acquireLease).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("settles a 4003 startup probe only after terminal persistence, then permits an immediate reopen", async () => {
    const { journal, journalPath, leasePath } = await createJournal();
    await journal.setLifecycle("revoked");
    const probeSocket = new FakeSocket();
    let probeCreated = false;
    let releaseTerminal: (() => void) | undefined;
    let terminalEntered = false;
    const terminalBlocked = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const service = new RelayService({
      account,
      journal,
      leasePath,
      socketFactory: () => {
        probeCreated = true;
        return probeSocket as unknown as RelaySocket;
      },
      callbacks: {
        onTerminal: async () => {
          terminalEntered = true;
          await terminalBlocked;
        },
      },
    });

    const started = service.start();
    let settled = false;
    void started.then(() => { settled = true; });
    await waitFor(() => expect(probeCreated).toBe(true));
    probeSocket.close(4003, "Installation revoked");
    await settle();

    expect(settled).toBe(false);
    expect(journal.getLifecycle()).toEqual({ fence: "revoked" });
    await waitFor(() => expect(terminalEntered).toBe(true));
    releaseTerminal?.();
    await expect(started).resolves.toBe(false);

    const reopened = await RelayJournal.open(journalPath);
    const reconnectSocket = new FakeSocket();
    let reconnectCreated = false;
    const reconnect = new RelayService({
      account,
      journal: reopened,
      leasePath,
      socketFactory: () => {
        reconnectCreated = true;
        return reconnectSocket as unknown as RelaySocket;
      },
    });
    const restarted = reconnect.start();
    await waitFor(() => expect(reconnectCreated).toBe(true));
    reconnectSocket.open();
    await expect(restarted).resolves.toBe(true);
    await reconnect.stop();
  });

  it("does not retry or retain the lease when a revoked startup probe cannot construct a socket", async () => {
    const { journal, leasePath } = await createJournal();
    await journal.setLifecycle("revoked");
    const timer = new FakeTimer();
    const release = vi.fn(async () => undefined);
    const socketFactory = vi.fn(() => {
      throw new Error("upgrade failed");
    });
    const service = new RelayService({
      account,
      journal,
      leasePath,
      timers: timer,
      acquireLease: async () => ({ release }),
      socketFactory,
    });

    await expect(service.start()).resolves.toBe(false);

    expect(service.getState()).toBe("revoked");
    expect(journal.getLifecycle()).toEqual({ fence: "revoked" });
    expect(socketFactory).toHaveBeenCalledOnce();
    expect(timer.scheduled).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps ordinary background startup active when initial socket construction needs a retry", async () => {
    const { journal, leasePath } = await createJournal();
    const timer = new FakeTimer();
    const socketFactory = vi.fn(() => {
      throw new Error("network unavailable");
    });
    const service = new RelayService({ account, journal, leasePath, timers: timer, socketFactory });

    await expect(service.start()).resolves.toBe(true);

    expect(service.getState()).toBe("reconnect_wait");
    expect(socketFactory).toHaveBeenCalledOnce();
    expect(timer.scheduled).toHaveLength(1);
    await service.stop();
  });

  it("refuses a device-replaced fence without acquiring a lease or creating a socket", async () => {
    const { journal, leasePath } = await createJournal();
    await journal.setLifecycle("device_replaced", 2, {
      agentId: "agent-1",
      deviceId: "device-1",
      enrollmentGeneration: 1,
    });
    const acquireLease = vi.fn(async () => ({ release: vi.fn(async () => undefined) }));
    const socketFactory = vi.fn(() => new FakeSocket() as unknown as RelaySocket);
    const service = new RelayService({ account, journal, leasePath, acquireLease, socketFactory });

    await expect(service.start()).resolves.toBe(false);

    expect(service.getState()).toBe("device_replaced");
    expect(acquireLease).not.toHaveBeenCalled();
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("makes one replacement probe and replays rebound frames only after authenticated open", async () => {
    const { journal, leasePath } = await createJournal();
    const pending = outbound({
      ...base,
      id: "50000000-0000-4000-8000-000000000001",
      type: "activity",
      sessionId: "session-1",
      idempotencyKey: "activity-1",
      payload: {
        commandId: "50000000-0000-4000-8000-000000000002",
        activity: { type: "thought", body: "pending" },
      },
    });
    if (pending.type !== "activity") throw new Error("Unexpected test frame type");
    await journal.addReplay({ key: "activity", kind: "activity", deliveryId: "delivery-1", frame: pending });
    await journal.setLifecycle("device_replaced", 2, {
      agentId: "agent-1",
      deviceId: "device-1",
      enrollmentGeneration: 1,
    });
    const replacement = { ...account, deviceId: "device-2", enrollmentGeneration: 2 };
    const socket = new FakeSocket();
    const timer = new FakeTimer();
    const socketFactory = vi.fn(() => socket as unknown as RelaySocket);
    const service = new RelayService({ account: replacement, journal, leasePath, socketFactory, timers: timer });

    const started = service.start();
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    expect(socket.sent).toEqual([]);
    expect(journal.getLifecycle().fence).toBe("device_replaced");
    socket.open();

    await expect(started).resolves.toBe(true);
    expect(journal.getLifecycle()).toEqual({ fence: "normal" });
    expect(socket.sent.map((value) => parseOutboundRelayFrame(value).deviceId)).toEqual(["device-2"]);
    socket.close(1006, "connection lost");
    await waitFor(() => expect(timer.scheduled).toHaveLength(1));
    await service.stop();
  });

  it("reconnects when the authenticated replacement socket closes during journal activation", async () => {
    const { journal, leasePath } = await createJournal();
    await journal.setLifecycle("device_replaced", 2, {
      agentId: "agent-1",
      deviceId: "device-1",
      enrollmentGeneration: 1,
    });
    const replacement = { ...account, deviceId: "device-2", enrollmentGeneration: 2 };
    let resumeActivation: (() => void) | undefined;
    const activationPaused = new Promise<void>((resolve) => {
      resumeActivation = resolve;
    });
    const activateReplacement = journal.activateReplacement.bind(journal);
    vi.spyOn(journal, "activateReplacement").mockImplementation(async (enrollment) => {
      await activationPaused;
      await activateReplacement(enrollment);
    });
    const firstSocket = new FakeSocket();
    const reconnectSocket = new FakeSocket();
    const sockets = [firstSocket, reconnectSocket];
    const socketFactory = vi.fn(() => {
      const socket = sockets.shift();
      if (socket === undefined) throw new Error("Unexpected relay connection");
      return socket as unknown as RelaySocket;
    });
    const release = vi.fn(async () => undefined);
    const timer = new FakeTimer();
    const service = new RelayService({
      account: replacement,
      journal,
      leasePath,
      socketFactory,
      timers: timer,
      acquireLease: vi.fn(async () => ({ release })),
    });

    const started = service.start();
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    firstSocket.open();
    firstSocket.close(1006, "connection lost during activation");
    await settle();

    expect(journal.getLifecycle().fence).toBe("device_replaced");
    expect(timer.scheduled).toEqual([]);
    expect(release).not.toHaveBeenCalled();

    resumeActivation?.();
    await expect(started).resolves.toBe(true);
    await waitFor(() => expect(service.getState()).toBe("reconnect_wait"));
    expect(journal.getLifecycle()).toEqual({ fence: "normal" });
    expect(timer.scheduled).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();

    timer.fireNext();
    expect(socketFactory).toHaveBeenCalledTimes(2);
    reconnectSocket.open();
    await waitFor(() => expect(service.getState()).toBe("connected"));
    expect(release).not.toHaveBeenCalled();
    await service.stop();
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails closed when replacement journal activation fails after authenticated open", async () => {
    const { journal, leasePath } = await createJournal();
    await journal.setLifecycle("device_replaced", 2, {
      agentId: "agent-1",
      deviceId: "device-1",
      enrollmentGeneration: 1,
    });
    vi.spyOn(journal, "activateReplacement").mockRejectedValue(new Error("disk unavailable"));
    const socket = new FakeSocket();
    const release = vi.fn(async () => undefined);
    const timer = new FakeTimer();
    const service = new RelayService({
      account: { ...account, deviceId: "device-2", enrollmentGeneration: 2 },
      journal,
      leasePath,
      timers: timer,
      socketFactory: () => socket as unknown as RelaySocket,
      acquireLease: vi.fn(async () => ({ release })),
    });

    const started = service.start();
    await waitFor(() => expect(service.getState()).toBe("starting"));
    socket.open();

    await expect(started).resolves.toBe(false);
    expect(service.getState()).toBe("device_replaced");
    expect(journal.getLifecycle()).toMatchObject({ fence: "device_replaced", generation: 2 });
    expect(socket.closes).toContainEqual({ code: 1011, reason: "Replacement activation failed" });
    expect(release).toHaveBeenCalledOnce();
    expect(timer.scheduled).toEqual([]);
  });

  it("keeps a replacement fence after one failed probe and does not retry", async () => {
    const { journal, leasePath } = await createJournal();
    await journal.setLifecycle("device_replaced", 2, {
      agentId: "agent-1",
      deviceId: "device-1",
      enrollmentGeneration: 1,
    });
    const socket = new FakeSocket();
    const timer = new FakeTimer();
    const socketFactory = vi.fn(() => socket as unknown as RelaySocket);
    const service = new RelayService({
      account: { ...account, deviceId: "device-2", enrollmentGeneration: 2 },
      journal,
      leasePath,
      socketFactory,
      timers: timer,
    });

    const started = service.start();
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    socket.close(1006, "network failure");

    await expect(started).resolves.toBe(false);
    expect(service.getState()).toBe("device_replaced");
    expect(journal.getLifecycle()).toMatchObject({
      fence: "device_replaced",
      enrollment: { deviceId: "device-1" },
    });
    expect(timer.scheduled).toEqual([]);
  });

  it("refreshes an exact rejected replacement probe with the attempted enrollment", async () => {
    const { journal, leasePath } = await createJournal();
    await journal.setLifecycle("device_replaced", 2, {
      agentId: "agent-1",
      deviceId: "device-1",
      enrollmentGeneration: 1,
    });
    const socket = new FakeSocket();
    const replacement = { ...account, deviceId: "device-2", enrollmentGeneration: 2 };
    const socketFactory = vi.fn(() => socket as unknown as RelaySocket);
    const service = new RelayService({
      account: replacement,
      journal,
      leasePath,
      socketFactory,
    });

    const started = service.start();
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    socket.unexpectedResponse(409, '{"error":"device_replaced"}');
    await waitFor(() => expect(service.getState()).toBe("device_replaced"));
    socket.close(1006, "upgrade rejected");

    await expect(started).resolves.toBe(false);
    expect(journal.getLifecycle()).toEqual({
      fence: "device_replaced",
      generation: 2,
      enrollment: { agentId: "agent-1", deviceId: "device-2", enrollmentGeneration: 2 },
    });
  });

  it("durably fences only the exact stale-generation upgrade response", async () => {
    const { journal, leasePath } = await createJournal();
    const socket = new FakeSocket();
    const terminal: string[] = [];
    let created = false;
    const service = new RelayService({
      account,
      journal,
      leasePath,
      socketFactory: () => {
        created = true;
        return socket as unknown as RelaySocket;
      },
      callbacks: { onTerminal: (reason) => { terminal.push(reason); } },
    });

    const started = service.start({ awaitOpen: true });
    await waitFor(() => expect(created).toBe(true));
    socket.unexpectedResponse(409, '{"error":"device_replaced"}');
    await waitFor(() => expect(service.getState()).toBe("device_replaced"));
    socket.close(1006, "upgrade rejected");

    await expect(started).resolves.toBe(false);
    expect(journal.getLifecycle()).toEqual({
      fence: "device_replaced",
      generation: account.enrollmentGeneration,
      enrollment: { agentId: "agent-1", deviceId: "device-1", enrollmentGeneration: 1 },
    });
    expect(terminal).toEqual(["device_replaced"]);
  });

  it.each([
    [401, '{"error":"device_replaced"}'],
    [409, '{"error":"device_replaced","detail":"extra"}'],
    [409, '{"error":"device_authentication_failed"}'],
    [409, "not-json"],
    [409, undefined],
  ] as const)("keeps generic upgrade rejection %s content-free", async (statusCode, body) => {
    const { journal, leasePath } = await createJournal();
    await journal.setLifecycle("revoked");
    const socket = new FakeSocket();
    let created = false;
    const service = new RelayService({
      account,
      journal,
      leasePath,
      socketFactory: () => {
        created = true;
        return socket as unknown as RelaySocket;
      },
    });

    const started = service.start();
    await waitFor(() => expect(created).toBe(true));
    socket.unexpectedResponse(statusCode, body);
    socket.close(1006, "upgrade rejected");

    await expect(started).resolves.toBe(false);
    expect(service.getState()).toBe("revoked");
    expect(journal.getLifecycle()).toEqual({ fence: "revoked" });
  });

  it("treats an unexplained 4001 close as reconnectable rather than a replacement fence", async () => {
    const { journal, leasePath } = await createJournal();
    const socket = new FakeSocket();
    const timer = new FakeTimer();
    const service = new RelayService({
      account,
      journal,
      leasePath,
      timers: timer,
      socketFactory: () => socket as unknown as RelaySocket,
    });
    await service.start();
    socket.open();
    socket.close(4001, "replaced connection");

    await waitFor(() => expect(service.getState()).toBe("reconnect_wait"));
    expect(journal.getLifecycle()).toEqual({ fence: "normal" });
    await service.stop();
  });
});
