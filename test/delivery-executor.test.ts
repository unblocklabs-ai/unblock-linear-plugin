import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it, vi } from "vitest";
import {
  DeliveryExecutor,
  type DeliveryRuntimePort,
  type RelayPort,
} from "../src/delivery/executor.js";
import {
  LINEAR_RUN_BINDING_KEY,
  parseLinearRunBinding,
  readLinearRunBinding,
  resolveLinearRunBinding,
} from "../src/linear/run-binding.js";
import { RelayJournal, type SessionBinding } from "../src/relay/journal.js";
import type { InboundRelayFrame, OutboundRelayFrame } from "../src/relay/protocol.js";

type DeliveryFrame = Extract<InboundRelayFrame, { type: "delivery" }>;
type RunEmbeddedAgent = DeliveryRuntimePort["agent"]["runEmbeddedAgent"];

const cfg: OpenClawConfig = {
  agents: {
    list: [
      { id: "selected-agent", workspace: "/tmp/selected-workspace" },
      { id: "relay-worker-agent", workspace: "/tmp/wrong-workspace" },
    ],
  },
  bindings: [
    { agentId: "selected-agent", match: { channel: "unblock-linear", accountId: "default" } },
  ],
};

const route = {
  agentId: "selected-agent",
  channel: "unblock-linear",
  accountId: "default",
  sessionKey: "agent:selected-agent:unblock-linear:default:direct:linear-session",
  mainSessionKey: "agent:selected-agent:main",
  lastRoutePolicy: "session",
  matchedBy: "binding.account",
} as const;

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function idFactory(start = 10_000): () => string {
  let next = start;
  return () => uuid(next++);
}

function deliveryFrame(input: {
  delivery?: number;
  frame?: number;
  sessionId?: string;
  teamId?: string;
  action?: "created" | "prompted";
  sequence?: number;
  openclawSessionId?: string;
  prompt?: string;
} = {}): DeliveryFrame {
  const deliveryId = uuid(input.delivery ?? 100);
  return {
    v: 1,
    id: uuid(input.frame ?? 1),
    type: "delivery",
    agentId: "relay-worker-agent",
    deviceId: "relay-device",
    timestamp: "2026-08-12T12:00:00.000Z",
    sessionId: input.sessionId ?? "linear-session",
    idempotencyKey: deliveryId,
    payload: {
      deliveryId,
      action: input.action ?? "created",
      sequence: input.sequence ?? 1,
      teamId: input.teamId ?? "linear-team",
      ...(input.openclawSessionId === undefined
        ? {}
        : { openclawSessionId: input.openclawSessionId }),
      prompt: input.prompt ?? "Handle the Linear issue.",
    },
  };
}

async function journalFixture(): Promise<RelayJournal> {
  const directory = await mkdtemp(join(tmpdir(), "unblock-linear-executor-"));
  return RelayJournal.open(join(directory, "relay.json"));
}

function runtimeFixture(run: RunEmbeddedAgent = async () => ({
  payloads: [{ text: "Work completed." }],
  meta: { durationMs: 1 },
})) {
  const runEmbeddedAgent = vi.fn(run);
  const resolveAgentRoute = vi.fn<
    DeliveryRuntimePort["channel"]["routing"]["resolveAgentRoute"]
  >(() => route);
  type SessionEntry = NonNullable<
    ReturnType<DeliveryRuntimePort["agent"]["session"]["getSessionEntry"]>
  >;
  const sessionEntries = new Map<string, SessionEntry>();
  const buildContext = vi.fn(() => ({
    CommandAuthorized: false,
  })) as unknown as DeliveryRuntimePort["channel"]["inbound"]["buildContext"];
  const recordInboundSession = vi.fn<
    DeliveryRuntimePort["channel"]["session"]["recordInboundSession"]
  >(async (input) => {
    sessionEntries.set(input.sessionKey, sessionEntries.get(input.sessionKey) ?? {
      sessionId: "persisted-selected-session",
      updatedAt: 0,
    });
  });
  const runtime: DeliveryRuntimePort = {
    channel: {
      routing: { resolveAgentRoute },
      inbound: { buildContext },
      session: { recordInboundSession },
    },
    agent: {
      runEmbeddedAgent,
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/selected-workspace"),
      resolveAgentDir: vi.fn(() => "/tmp/selected-agent"),
      resolveAgentTimeoutMs: vi.fn(() => 60_000),
      ensureAgentWorkspace: vi.fn(async (params) => ({ dir: params?.dir ?? "/tmp/selected-workspace" })),
      session: {
        resolveStorePath: vi.fn(() => "/tmp/selected-agent/sessions.json"),
        getSessionEntry: vi.fn((input) => sessionEntries.get(input.sessionKey)),
      },
    },
  };
  return {
    runtime,
    runEmbeddedAgent,
    resolveAgentRoute,
    buildContext,
    recordInboundSession,
    sessionEntries,
  };
}

function relayFixture(journal: RelayJournal) {
  const sent: OutboundRelayFrame[] = [];
  const persistenceChecks: string[] = [];
  const send: RelayPort["send"] = vi.fn(async (frame) => {
    const delivery = journal.getDelivery(frame.payload.deliveryId);
    const binding = journal.getBinding(frame.sessionId);
    if (delivery?.openclawSessionId === frame.payload.openclawSessionId && binding) {
      persistenceChecks.push("accept-after-delivery-and-binding");
    }
    sent.push(frame);
  });
  const sendActivity: RelayPort["sendActivity"] = vi.fn(async (frame, deliveryId) => {
    await journal.addReplay({
      key: `activity:${frame.payload.commandId}`,
      kind: "activity",
      deliveryId,
      frame,
    });
    persistenceChecks.push(`persist-before-activity:${frame.payload.commandId}`);
    sent.push(frame);
    return true;
  });
  const sendDeliveryStatus: RelayPort["sendDeliveryStatus"] = vi.fn(async (frame) => {
    await journal.addReplay({
      key: `delivery-status:${frame.payload.deliveryId}:${frame.payload.status}`,
      kind: "delivery_status",
      frame,
    });
    persistenceChecks.push(`persist-before-status:${frame.payload.status}`);
    sent.push(frame);
    return true;
  });
  const relay: RelayPort = { send, sendActivity, sendDeliveryStatus };
  return { relay, sent, persistenceChecks };
}

function executorFixture(input: {
  journal: RelayJournal;
  run?: RunEmbeddedAgent;
  inspectRecovery?: ConstructorParameters<typeof DeliveryExecutor>[0]["inspectRecovery"];
  createId?: () => string;
}) {
  const runtime = runtimeFixture(input.run);
  const relay = relayFixture(input.journal);
  const executor = new DeliveryExecutor({
    runtime: runtime.runtime,
    config: cfg,
    accountId: "default",
    relayIdentity: { agentId: "relay-worker-agent", deviceId: "relay-device" },
    relay: relay.relay,
    journal: input.journal,
    inspectRecovery: input.inspectRecovery,
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    createId: input.createId ?? idFactory(),
  });
  return { executor, ...runtime, ...relay };
}

function statusFrames(sent: OutboundRelayFrame[]) {
  return sent.filter((frame): frame is Extract<OutboundRelayFrame, { type: "delivery.status" }> =>
    frame.type === "delivery.status");
}

async function acknowledgeStatuses(journal: RelayJournal, sent: OutboundRelayFrame[]): Promise<void> {
  for (const frame of statusFrames(sent)) {
    await journal.acknowledgeDeliveryStatus({
      v: 1,
      id: uuid(90_000 + frame.payload.status.length),
      type: "delivery.ack",
      agentId: frame.agentId,
      deviceId: frame.deviceId,
      timestamp: "2026-08-12T12:01:00.000Z",
      sessionId: frame.sessionId,
      idempotencyKey: frame.idempotencyKey,
      payload: {
        deliveryId: frame.payload.deliveryId,
        status: frame.payload.status,
      },
    });
  }
}

describe("DeliveryExecutor", () => {
  it("accepts only the exact four-field run binding shape", () => {
    const binding = {
      linearSessionId: "linear-session",
      contextId: "openclaw-session",
      deliveryId: uuid(99),
      teamId: "linear-team",
    };
    expect(LINEAR_RUN_BINDING_KEY).toBe("unblock-linear.run");
    expect(parseLinearRunBinding(binding)).toEqual(binding);
    expect(parseLinearRunBinding({ ...binding, extra: true })).toBeUndefined();
    expect(parseLinearRunBinding({ ...binding, contextId: "" })).toBeUndefined();
  });

  it("routes by standard channel binding, persists before sends, and leaves tool policy untouched", async () => {
    const journal = await journalFixture();
    const fixture = executorFixture({ journal, createId: idFactory(20_000) });
    const frame = deliveryFrame();

    const result = await fixture.executor.execute(frame);

    expect(result).toMatchObject({ outcome: "completed", recovered: false });
    expect(fixture.resolveAgentRoute).toHaveBeenCalledWith({
      cfg,
      channel: "unblock-linear",
      accountId: "default",
      peer: { kind: "direct", id: "linear-session" },
      teamId: "linear-team",
    });
    expect(fixture.resolveAgentRoute.mock.calls[0]?.[0]).not.toHaveProperty("agentId");
    const binding = journal.getBinding("linear-session");
    expect(binding).toMatchObject({
      openclawSessionId: "persisted-selected-session",
      routing: route,
      sessionTarget: {
        agentId: "selected-agent",
        sessionId: "persisted-selected-session",
        sessionKey: route.sessionKey,
        storePath: "/tmp/selected-agent/sessions.json",
      },
    });
    expect(fixture.recordInboundSession).toHaveBeenCalledWith(expect.objectContaining({
      storePath: "/tmp/selected-agent/sessions.json",
      sessionKey: route.sessionKey,
      createIfMissing: true,
      updateLastRoute: expect.objectContaining({
        sessionKey: route.sessionKey,
        channel: "unblock-linear",
        to: frame.sessionId,
      }),
    }));
    expect(fixture.persistenceChecks).toContain("accept-after-delivery-and-binding");
    expect(fixture.persistenceChecks).toContain("persist-before-status:started");
    expect(fixture.persistenceChecks).toContain("persist-before-status:completed");

    const runInput = fixture.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(runInput).toMatchObject({
      agentId: "selected-agent",
      sessionId: binding?.openclawSessionId,
      sessionKey: route.sessionKey,
      sessionTarget: binding?.sessionTarget,
      prompt: frame.payload.prompt,
      transcriptPrompt: frame.payload.prompt,
    });
    expect(runInput).not.toHaveProperty("toolsAllow");
    expect(runInput).not.toHaveProperty("toolOverrides");
    expect(runInput).not.toHaveProperty("disableTools");
    expect(readLinearRunBinding(runInput?.toolBindings)).toEqual({
      linearSessionId: "linear-session",
      contextId: binding?.openclawSessionId,
      deliveryId: frame.payload.deliveryId,
      teamId: "linear-team",
    });
    expect(runInput?.toolBindings).toHaveProperty(LINEAR_RUN_BINDING_KEY);
    expect(journal.getDelivery(frame.payload.deliveryId)).toMatchObject({
      status: "completed",
      terminalAcknowledged: false,
      transcriptWatermark: { turnId: frame.payload.deliveryId },
    });
  });

  it.each(["success", "error"] as const)(
    "scopes the beta.7 fallback to the embedded run on %s",
    async (outcome) => {
      const journal = await journalFixture();
      let observed: ReturnType<typeof resolveLinearRunBinding>;
      const identity = {
        agentId: "selected-agent",
        sessionId: "persisted-selected-session",
        sessionKey: route.sessionKey,
      };
      const fixture = executorFixture({
        journal,
        run: async () => {
          observed = resolveLinearRunBinding(identity);
          if (outcome === "error") throw new Error("embedded run failed");
          return { payloads: [{ text: "Done" }], meta: { durationMs: 1 } };
        },
      });
      const frame = deliveryFrame({ delivery: outcome === "success" ? 105 : 106 });

      await expect(fixture.executor.execute(frame)).resolves.toMatchObject({
        outcome: outcome === "success" ? "completed" : "failed",
      });

      expect(observed).toEqual({
        linearSessionId: frame.sessionId,
        contextId: "persisted-selected-session",
        deliveryId: frame.payload.deliveryId,
        teamId: frame.payload.teamId,
      });
      expect(resolveLinearRunBinding(identity)).toBeUndefined();
    },
  );

  it("reuses the exact persisted target for prompted deliveries and terminal replay", async () => {
    const journal = await journalFixture();
    const fixture = executorFixture({ journal, createId: idFactory(30_000) });
    const created = deliveryFrame({ delivery: 110 });
    await fixture.executor.execute(created);
    const stableBinding = journal.getBinding(created.sessionId);
    await acknowledgeStatuses(journal, fixture.sent);
    await journal.compactAcknowledgedDelivery(created.payload.deliveryId);
    fixture.sent.length = 0;

    const prompted = deliveryFrame({
      delivery: 111,
      frame: 2,
      action: "prompted",
      sequence: 2,
      openclawSessionId: stableBinding?.openclawSessionId,
      prompt: "Continue the same Linear session.",
    });
    const first = await fixture.executor.execute(prompted);
    await journal.updateDelivery(prompted.payload.deliveryId, { status: "accepted" });
    const replay = await fixture.executor.execute(prompted);

    expect(first.binding).toEqual(stableBinding);
    expect(replay).toMatchObject({ outcome: "completed", recovered: true, binding: stableBinding });
    expect(fixture.resolveAgentRoute).toHaveBeenCalledTimes(1);
    expect(fixture.runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(fixture.runEmbeddedAgent.mock.calls[1]?.[0].sessionTarget).toEqual(stableBinding?.sessionTarget);
    expect(journal.getDelivery(prompted.payload.deliveryId)?.status).toBe("completed");
  });

  it("uses transcript/tool recovery facts without claiming exactly-once execution", async () => {
    const journal = await journalFixture();
    const frame = deliveryFrame({ delivery: 120 });
    const binding: SessionBinding = {
      linearSessionId: frame.sessionId,
      teamId: frame.payload.teamId,
      openclawSessionId: uuid(777),
      sessionTarget: {
        agentId: route.agentId,
        sessionId: uuid(777),
        sessionKey: route.sessionKey,
        storePath: "/tmp/selected-agent/sessions.json",
      },
      routing: route,
      createdAt: "2026-08-12T12:00:00.000Z",
    };
    await journal.bindSession(binding);
    await journal.recordDelivery({
      deliveryId: frame.payload.deliveryId,
      sessionId: frame.sessionId,
      teamId: frame.payload.teamId,
      idempotencyKey: frame.idempotencyKey,
      action: frame.payload.action,
      sequence: frame.payload.sequence,
      prompt: frame.payload.prompt,
      status: "started",
      terminalAcknowledged: false,
      openclawSessionId: binding.openclawSessionId,
      transcriptWatermark: { turnId: "turn-before-crash" },
      toolRecovery: {
        state: "ambiguous",
        toolCallId: "tool-before-crash",
        toolName: "message",
        reconciliationRequired: true,
      },
      recordedAt: "2026-08-12T12:00:00.000Z",
    });
    const inspectRecovery = vi.fn(async () => ({ kind: "reconcile" as const }));
    const fixture = executorFixture({ journal, inspectRecovery });

    const result = await fixture.executor.execute(frame);

    expect(result.recovered).toBe(true);
    expect(inspectRecovery).toHaveBeenCalledWith(expect.objectContaining({
      transcriptWatermark: { turnId: "turn-before-crash" },
      toolRecovery: expect.objectContaining({ state: "ambiguous", reconciliationRequired: true }),
    }));
    expect(fixture.resolveAgentRoute).not.toHaveBeenCalled();
    expect(fixture.runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
      sessionTarget: binding.sessionTarget,
      prompt: frame.payload.prompt,
      extraSystemPrompt: expect.stringContaining("reconcile prior tool effects"),
    });
  });

  it("isolates session and team cancellation to the matching active delivery", async () => {
    const journal = await journalFixture();
    let observedSignal: AbortSignal | undefined;
    let runStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const run: RunEmbeddedAgent = async (input) => {
      observedSignal = input.abortSignal;
      runStarted?.();
      await new Promise<void>((resolve, reject) => {
        input.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        if (input.abortSignal?.aborted) resolve();
      });
      return { meta: { durationMs: 1 } };
    };
    const fixture = executorFixture({ journal, run });
    const cancelRpcs = vi.spyOn(journal, "removeCanceledSessionRpcs");
    const frame = deliveryFrame({ delivery: 130 });
    const execution = fixture.executor.execute(frame);
    await started;

    expect(journal.getDelivery(frame.payload.deliveryId)?.status).toBe("started");

    await expect(fixture.executor.handleSessionStop("other-session")).resolves.toBe(false);
    await expect(fixture.executor.handleTeamAccessRemoved("other-team")).resolves.toBe(false);
    expect(observedSignal?.aborted).toBe(false);
    await expect(fixture.executor.handleSessionStop(frame.sessionId)).resolves.toBe(true);
    const result = await execution;

    expect(observedSignal?.aborted).toBe(true);
    expect(result.outcome).toBe("canceled");
    expect(cancelRpcs).toHaveBeenCalledWith(frame.sessionId);
    expect(statusFrames(fixture.sent).at(-1)?.payload.status).toBe("canceled");
    expect(journal.getDelivery(frame.payload.deliveryId)).toMatchObject({
      status: "canceled",
      terminalAcknowledged: false,
    });

    const teamJournal = await journalFixture();
    let teamStarted: (() => void) | undefined;
    const teamRunStarted = new Promise<void>((resolve) => {
      teamStarted = resolve;
    });
    const teamFixture = executorFixture({
      journal: teamJournal,
      run: async (input) => {
        teamStarted?.();
        await new Promise<void>((_resolve, reject) => {
          input.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return { meta: { durationMs: 1 } };
      },
    });
    const teamFrame = deliveryFrame({ delivery: 131, sessionId: "team-session", teamId: "affected-team" });
    const teamExecution = teamFixture.executor.execute(teamFrame);
    await teamRunStarted;
    await expect(teamFixture.executor.handleTeamAccessRemoved("affected-team")).resolves.toBe(true);
    await expect(teamExecution).resolves.toMatchObject({ outcome: "canceled" });
  });

  it("persists terminal cancellation before resolving an offline global abort", async () => {
    const journal = await journalFixture();
    let runStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    let fallbackIdentity: {
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
    } | undefined;
    const run: RunEmbeddedAgent = async (input) => {
      fallbackIdentity = {
        agentId: input.agentId,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
      };
      expect(resolveLinearRunBinding(fallbackIdentity)).toMatchObject({
        linearSessionId: "linear-session",
      });
      runStarted?.();
      await new Promise<void>((_resolve, reject) => {
        input.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { meta: { durationMs: 1 } };
    };
    const fixture = executorFixture({ journal, run });
    const frame = deliveryFrame({ delivery: 131 });
    const execution = fixture.executor.execute(frame);
    await started;

    await expect(fixture.executor.abortAllAndWaitOffline()).resolves.toBe(true);
    await expect(execution).resolves.toMatchObject({ outcome: "canceled" });
    expect(resolveLinearRunBinding(fallbackIdentity ?? {})).toBeUndefined();
    expect(journal.getDelivery(frame.payload.deliveryId)).toMatchObject({
      status: "canceled",
      terminalAcknowledged: false,
    });
    expect(journal.getReplayEntries(frame.payload.deliveryId).find((entry) =>
      entry.key === `delivery-status:${frame.payload.deliveryId}:canceled`,
    )).toEqual(expect.objectContaining({
      key: `delivery-status:${frame.payload.deliveryId}:canceled`,
      kind: "delivery_status",
      frame: expect.objectContaining({
        type: "delivery.status",
        payload: expect.objectContaining({ status: "canceled" }),
      }),
    }));
  });

  it("aborts all active work immediately and durably cancels its session RPCs", async () => {
    const journal = await journalFixture();
    let runStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const fixture = executorFixture({
      journal,
      run: async (input) => {
        observedSignal = input.abortSignal;
        runStarted?.();
        await new Promise<void>((_resolve, reject) => {
          input.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return { meta: { durationMs: 1 } };
      },
    });
    const cancelRpcs = vi.spyOn(journal, "removeCanceledSessionRpcs");
    const frame = deliveryFrame({ delivery: 132 });
    const execution = fixture.executor.execute(frame);
    await started;

    const cancellation = fixture.executor.abortAllAndWait();
    expect(observedSignal?.aborted).toBe(true);
    await expect(cancellation).resolves.toBe(true);
    await expect(execution).resolves.toMatchObject({ outcome: "canceled" });
    expect(cancelRpcs).toHaveBeenCalledWith(frame.sessionId);
    expect(journal.getDelivery(frame.payload.deliveryId)).toMatchObject({
      status: "canceled",
      terminalAcknowledged: false,
    });
    await expect(fixture.executor.abortAllAndWait()).resolves.toBe(false);
  });

  it("projects only bounded safe phases, tool metadata, elicitation, and final response", async () => {
    const journal = await journalFixture();
    let finishRun: (() => void) | undefined;
    let runStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const run: RunEmbeddedAgent = async (input) => {
      input.onExecutionPhase?.({
        phase: "turn_accepted",
        provider: "private-provider",
        model: "private-model",
      });
      input.onExecutionPhase?.({
        phase: "tool_execution_started",
        tool: "linear",
        toolCallId: "private-tool-call-id",
        source: "private-source",
      });
      input.onAgentToolResult?.({
        toolName: "linear",
        result: { secret: "private-tool-result" },
        isError: false,
      });
      runStarted?.();
      await finish;
      return {
        payloads: [
          { text: "private chain of thought", isReasoning: true },
          { text: "private internal commentary", isCommentary: true },
          { text: "Safe final response." },
        ],
        meta: { durationMs: 1, finalPromptText: "private prompt copy" },
      };
    };
    const fixture = executorFixture({ journal, run, createId: idFactory(40_000) });
    const frame = deliveryFrame({ delivery: 140, prompt: "private inbound prompt" });
    const execution = fixture.executor.execute(frame);
    await started;
    await expect(fixture.executor.emitElicitation({
      deliveryId: frame.payload.deliveryId,
      body: "Which safe option should I use?",
    })).resolves.toBe(true);
    finishRun?.();
    await execution;

    const activities = fixture.sent.flatMap((sent) =>
      sent.type === "activity" ? [sent.payload.activity] : []);
    expect(activities).toEqual(expect.arrayContaining([
      { type: "thought", body: "OpenClaw accepted the delivery.", ephemeral: true },
      { type: "action", action: "linear", parameter: "phase=tool_execution_started" },
      { type: "elicitation", body: "Which safe option should I use?" },
      { type: "response", body: "Safe final response." },
    ]));
    const serialized = JSON.stringify(activities);
    expect(serialized).not.toContain("private-provider");
    expect(serialized).not.toContain("private-model");
    expect(serialized).not.toContain("private-tool-call-id");
    expect(serialized).not.toContain("private-tool-result");
    expect(serialized).not.toContain("private chain of thought");
    expect(serialized).not.toContain("private internal commentary");
    expect(serialized).not.toContain("private inbound prompt");
  });
});
