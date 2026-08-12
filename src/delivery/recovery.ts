import {
  getSessionEntry,
  readRecentUserAssistantTextForSession,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import type {
  DeliveryRecord,
  SessionBinding,
  ToolRecovery,
  TranscriptWatermark,
} from "../relay/journal.js";

const TRANSCRIPT_LIMIT = 64;
// Stored in eventId, which this plugin never otherwise populates. A NUL-prefixed
// marker cannot be a public OpenClaw message id and keeps an empty baseline distinct
// from an ID-less assistant history.
const EMPTY_ASSISTANT_BASELINE = "\u0000unblock-linear:empty-assistant-baseline:v1";

export type DeliveryRecoveryDecision =
  | {
      kind: "completed";
      response: string;
      transcriptWatermark?: TranscriptWatermark;
    }
  | {
      kind: "resume";
    }
  | {
      kind: "reconcile";
      instruction?: string;
    };

export type DeliveryRecoveryInspector = (input: {
  delivery: Readonly<DeliveryRecord>;
  binding: Readonly<SessionBinding>;
  transcriptWatermark: Readonly<TranscriptWatermark> | undefined;
  toolRecovery: Readonly<ToolRecovery>;
}) => Promise<DeliveryRecoveryDecision>;

type TranscriptReadRequest = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  role: "assistant";
  limit: number;
};

export type DeliveryTranscriptReader = (
  request: Readonly<TranscriptReadRequest>,
) => Promise<readonly unknown[]>;

export type DeliveryRecoveryInspectorOptions = {
  readTranscript?: DeliveryTranscriptReader;
  readSessionEntry?: DeliverySessionEntryReader;
};

export type DeliverySessionEntryReader = (request: Readonly<{
  agentId: string;
  sessionKey: string;
  storePath: string;
  readConsistency: "latest";
}>) => Pick<SessionEntry, "restartRecoveryTerminalRunIds"> | undefined;

export type DeliveryRecoveryBaselineOptions = Pick<
  DeliveryRecoveryInspectorOptions,
  "readTranscript"
>;

/**
 * Builds the recovery decision from the public, identity-scoped OpenClaw transcript API.
 *
 * Completion requires three independent, public facts: a durable run terminal marker, the
 * delivery's persisted pre-run assistant watermark, and a bounded assistant response after it.
 */
export function createDeliveryRecoveryInspector(
  options: DeliveryRecoveryInspectorOptions = {},
): DeliveryRecoveryInspector {
  const readTranscript = options.readTranscript ?? readPublicTranscript;
  const readSessionEntry = options.readSessionEntry ?? readPublicSessionEntry;

  return async (input) => {
    const fallback = recoveryFallback(input.toolRecovery);

    let transcript: readonly unknown[];
    let entry: Pick<SessionEntry, "restartRecoveryTerminalRunIds"> | undefined;
    try {
      const target = {
        agentId: input.binding.sessionTarget.agentId,
        sessionKey: input.binding.sessionTarget.sessionKey,
        storePath: input.binding.sessionTarget.storePath,
      };
      [transcript, entry] = await Promise.all([
        readTranscript({
          ...target,
          role: "assistant",
          limit: TRANSCRIPT_LIMIT,
        }),
        Promise.resolve(readSessionEntry({ ...target, readConsistency: "latest" })),
      ]);
    } catch {
      return { kind: "reconcile" };
    }

    if (!hasValidAssistantTranscript(transcript)) return { kind: "reconcile" };
    if (!hasTerminalRun(entry, input.delivery.deliveryId)) return fallback;
    const baseline = parseRecoveryBaseline(input.transcriptWatermark, input.delivery.deliveryId);
    if (baseline === undefined) return { kind: "reconcile" };
    const response = baseline.kind === "empty"
      ? onlyAssistantResponse(transcript)
      : assistantResponseAfter(transcript, baseline.messageId);
    if (response === undefined) return { kind: "reconcile" };

    return { kind: "completed", response };
  };
}

/** Captures the last bounded assistant entry before the fresh delivery run starts. */
export async function captureDeliveryRecoveryBaseline(
  binding: Readonly<SessionBinding>,
  deliveryId: string,
  options: DeliveryRecoveryBaselineOptions = {},
): Promise<TranscriptWatermark> {
  const readTranscript = options.readTranscript ?? readPublicTranscript;
  const baseline: TranscriptWatermark = { turnId: deliveryId };
  try {
    const transcript = await readTranscript({
      agentId: binding.sessionTarget.agentId,
      sessionKey: binding.sessionTarget.sessionKey,
      storePath: binding.sessionTarget.storePath,
      role: "assistant",
      limit: TRANSCRIPT_LIMIT,
    });
    if (!hasValidAssistantTranscript(transcript)) return baseline;
    const lastEntry = transcript.at(-1);
    const messageId = isRecord(lastEntry) ? lastEntry.id : undefined;
    return typeof messageId === "string" && messageId.length > 0
      ? { ...baseline, messageId }
      : transcript.length === 0
      ? { ...baseline, eventId: EMPTY_ASSISTANT_BASELINE }
      : baseline;
  } catch {
    return baseline;
  }
}

async function readPublicTranscript(
  request: Readonly<TranscriptReadRequest>,
): Promise<readonly unknown[]> {
  return readRecentUserAssistantTextForSession(request);
}

function readPublicSessionEntry(request: Readonly<{
  agentId: string;
  sessionKey: string;
  storePath: string;
  readConsistency: "latest";
}>): Pick<SessionEntry, "restartRecoveryTerminalRunIds"> | undefined {
  return getSessionEntry(request);
}

function parseRecoveryBaseline(
  watermark: Readonly<TranscriptWatermark> | undefined,
  deliveryId: string,
): { kind: "message"; messageId: string } | { kind: "empty" } | undefined {
  if (watermark?.turnId !== deliveryId) return undefined;
  if (typeof watermark.messageId === "string" && watermark.messageId.length > 0) {
    return { kind: "message", messageId: watermark.messageId };
  }
  return watermark?.eventId === EMPTY_ASSISTANT_BASELINE ? { kind: "empty" } : undefined;
}

function hasTerminalRun(
  entry: Pick<SessionEntry, "restartRecoveryTerminalRunIds"> | undefined,
  deliveryId: string,
): boolean {
  return Array.isArray(entry?.restartRecoveryTerminalRunIds) &&
    entry.restartRecoveryTerminalRunIds.every((runId) => typeof runId === "string") &&
    entry.restartRecoveryTerminalRunIds.includes(deliveryId);
}

function assistantResponseAfter(transcript: readonly unknown[], baselineMessageId: string): string | undefined {
  const baseline = transcript.findIndex((entry) => isRecord(entry) && entry.id === baselineMessageId);
  if (baseline < 0) return undefined;
  return onlyAssistantResponse(transcript.slice(baseline + 1));
}

function onlyAssistantResponse(transcript: readonly unknown[]): string | undefined {
  if (transcript.length !== 1) return undefined;
  const response = transcript[0];
  return isRecord(response) && typeof response.text === "string" && response.text.length > 0
    ? response.text
    : undefined;
}

function recoveryFallback(toolRecovery: Readonly<ToolRecovery>): DeliveryRecoveryDecision {
  return toolRecovery.state === "none" && !toolRecovery.reconciliationRequired
    ? { kind: "resume" }
    : { kind: "reconcile" };
}

function hasValidAssistantTranscript(transcript: readonly unknown[]): boolean {
  return transcript.every((entry) => {
    if (!isRecord(entry) || entry.role !== "assistant" || typeof entry.text !== "string") {
      return false;
    }
    return (entry.id === undefined || typeof entry.id === "string") &&
      (entry.timestamp === undefined || (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp))) &&
      (entry.sourceChannel === undefined || typeof entry.sourceChannel === "string");
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
