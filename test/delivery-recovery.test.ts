import { describe, expect, it, vi } from "vitest";
import {
  captureDeliveryRecoveryBaseline,
  createDeliveryRecoveryInspector,
  type DeliveryRecoveryInspector,
} from "../src/delivery/recovery.js";

const binding = {
  linearSessionId: "linear-session",
  teamId: "linear-team",
  openclawSessionId: "openclaw-session",
  sessionTarget: {
    agentId: "selected-agent",
    sessionId: "openclaw-session",
    sessionKey: "agent:selected-agent:unblock-linear:default:direct:linear-session",
    storePath: "/tmp/selected-agent/sessions.json",
  },
  routing: {
    agentId: "selected-agent",
    channel: "unblock-linear",
    accountId: "default",
    sessionKey: "agent:selected-agent:unblock-linear:default:direct:linear-session",
    mainSessionKey: "agent:selected-agent:main",
    lastRoutePolicy: "session",
    matchedBy: "binding.account",
  },
  createdAt: "2026-08-12T12:00:00.000Z",
} as const;

const delivery = {
  deliveryId: "00000000-0000-4000-8000-000000000100",
  sessionId: "linear-session",
  teamId: "linear-team",
  idempotencyKey: "00000000-0000-4000-8000-000000000100",
  action: "created",
  sequence: 1,
  prompt: "Handle the Linear issue.",
  status: "started",
  terminalAcknowledged: false,
  toolRecovery: { state: "none", reconciliationRequired: false },
  recordedAt: "2026-08-12T12:00:00.000Z",
} as const;

function recoveryInput(
  overrides: Partial<Parameters<DeliveryRecoveryInspector>[0]> = {},
): Parameters<DeliveryRecoveryInspector>[0] {
  return {
    delivery,
    binding,
    transcriptWatermark: undefined,
    toolRecovery: { state: "none", reconciliationRequired: false },
    ...overrides,
  };
}

describe("DeliveryRecoveryInspector", () => {
  it("recovers only a terminal delivery run with assistant output after its persisted baseline", async () => {
    const readTranscript = vi.fn(async () => [{
      id: "assistant-before",
      role: "assistant" as const,
      text: "A previous turn.",
      timestamp: 1_786_086_400_000,
    }, {
      id: "assistant-current",
      role: "assistant" as const,
      text: "The issue is complete.",
      timestamp: 1_786_086_401_000,
    }]);
    const readSessionEntry = vi.fn(() => ({
      restartRecoveryTerminalRunIds: [delivery.deliveryId],
    }));
    const inspect = createDeliveryRecoveryInspector({ readTranscript, readSessionEntry });

    await expect(inspect(recoveryInput({
      transcriptWatermark: { turnId: delivery.deliveryId, messageId: "assistant-before" },
    }))).resolves.toEqual({ kind: "completed", response: "The issue is complete." });
    expect(readTranscript).toHaveBeenCalledWith({
      agentId: binding.sessionTarget.agentId,
      sessionKey: binding.sessionTarget.sessionKey,
      storePath: binding.sessionTarget.storePath,
      role: "assistant",
      limit: 64,
    });
    expect(readSessionEntry).toHaveBeenCalledWith({
      agentId: binding.sessionTarget.agentId,
      sessionKey: binding.sessionTarget.sessionKey,
      storePath: binding.sessionTarget.storePath,
      readConsistency: "latest",
    });
  });

  it("reconciles rather than infer completion from an unrelated prior assistant turn", async () => {
    const inspect = createDeliveryRecoveryInspector({
      readTranscript: async () => [{
        id: "assistant-prior",
        role: "assistant",
        text: "A previous Linear request is complete.",
      }],
      readSessionEntry: () => ({ restartRecoveryTerminalRunIds: [delivery.deliveryId] }),
    });

    await expect(inspect(recoveryInput({
      transcriptWatermark: { turnId: delivery.deliveryId, messageId: "assistant-before-this-run" },
    })))
      .resolves.toEqual({ kind: "reconcile" });
  });

  it("resumes when no tool began and the scoped transcript is empty", async () => {
    const inspect = createDeliveryRecoveryInspector({ readTranscript: async () => [] });

    await expect(inspect(recoveryInput())).resolves.toEqual({ kind: "resume" });
  });

  it.each([
    { state: "started" as const, reconciliationRequired: true },
    { state: "completed" as const, reconciliationRequired: false },
    { state: "ambiguous" as const, reconciliationRequired: true },
  ])("reconciles when tool recovery is $state", async (toolRecovery) => {
    const inspect = createDeliveryRecoveryInspector({ readTranscript: async () => [] });

    await expect(inspect(recoveryInput({ toolRecovery }))).resolves.toEqual({ kind: "reconcile" });
  });

  it("fails safe when the public transcript reader returns malformed data", async () => {
    const inspect = createDeliveryRecoveryInspector({
      readTranscript: async () => [{ role: "assistant", text: "not valid", timestamp: Number.NaN }],
    });

    await expect(inspect(recoveryInput({
      transcriptWatermark: { turnId: delivery.deliveryId, messageId: "assistant-before" },
    }))).resolves.toEqual({ kind: "reconcile" });
  });

  it("persists only the last bounded assistant message as a fresh-run baseline", async () => {
    await expect(captureDeliveryRecoveryBaseline(binding, delivery.deliveryId, {
      readTranscript: async () => [{ id: "assistant-one", role: "assistant", text: "Earlier" }, {
        id: "assistant-two", role: "assistant", text: "Latest" },
      ],
    })).resolves.toEqual({ turnId: delivery.deliveryId, messageId: "assistant-two" });

    await expect(captureDeliveryRecoveryBaseline(binding, delivery.deliveryId, {
      readTranscript: async () => [],
    })).resolves.toMatchObject({ turnId: delivery.deliveryId, eventId: expect.any(String) });
  });

  it("recovers an exact terminal first delivery from a proven empty assistant baseline", async () => {
    const baseline = await captureDeliveryRecoveryBaseline(binding, delivery.deliveryId, {
      readTranscript: async () => [],
    });
    const inspect = createDeliveryRecoveryInspector({
      readTranscript: async () => [{ id: "assistant-first", role: "assistant", text: "First result." }],
      readSessionEntry: () => ({ restartRecoveryTerminalRunIds: [delivery.deliveryId] }),
    });

    await expect(inspect(recoveryInput({ transcriptWatermark: baseline })))
      .resolves.toEqual({ kind: "completed", response: "First result." });
  });

  it("reconciles an exact terminal run when the pre-run assistant cursor had no ID", async () => {
    const baseline = await captureDeliveryRecoveryBaseline(binding, delivery.deliveryId, {
      readTranscript: async () => [{ role: "assistant", text: "Unaddressable prior result." }],
    });
    const inspect = createDeliveryRecoveryInspector({
      readTranscript: async () => [{ role: "assistant", text: "Current result." }],
      readSessionEntry: () => ({ restartRecoveryTerminalRunIds: [delivery.deliveryId] }),
    });

    await expect(inspect(recoveryInput({ transcriptWatermark: baseline })))
      .resolves.toEqual({ kind: "reconcile" });
  });
});
