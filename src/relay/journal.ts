import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  MAX_RELAY_FRAME_BYTES,
  parseInboundRelayFrame,
  parseOutboundRelayFrame,
  type InboundRelayFrame,
  type OutboundRelayFrame,
} from "./protocol.js";
import { managedMediaId } from "../linear/media-ref.js";

/**
 * The relay journal is intentionally a private v1 file, not a general storage
 * layer.  Keep this schema small and explicit: the service owns the lifecycle
 * of these records and all values are validated before they reach disk.
 */
export const RELAY_JOURNAL_VERSION = 1 as const;
export const DEFAULT_JOURNAL_MAX_ENTRIES = 256;
export const DEFAULT_JOURNAL_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_PERSISTED_RPC_BYTES = 60 * 1024;

export type JournalLifecycleFence = "normal" | "revoked" | "enrollment_replaced";

export type FencedEnrollmentIdentity = {
  agentId: string;
  enrollmentGeneration: number;
};

export type JournalLifecycle =
  | { fence: "normal" }
  | { fence: "revoked"; enrollment: FencedEnrollmentIdentity }
  | {
      fence: "enrollment_replaced";
      generation: number;
      enrollment: FencedEnrollmentIdentity;
    };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

/** The resolved target is kept whole so a follow-up cannot re-resolve routing. */
export type OpenClawSessionTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  threadId?: string | number;
};

export type OpenClawRoutingIdentity = ResolvedAgentRoute;

export type SessionBinding = {
  linearSessionId: string;
  teamId: string;
  openclawSessionId: string;
  sessionTarget: OpenClawSessionTarget;
  routing: OpenClawRoutingIdentity;
  createdAt: string;
};

export type DeliveryStatus = "offered" | "accepted" | "started" | "completed" | "failed" | "canceled";

export type TranscriptWatermark = {
  messageId?: string;
  eventId?: string;
  turnId?: string;
};

export type ToolRecovery = {
  state: "none" | "started" | "completed" | "ambiguous";
  toolCallId?: string;
  toolName?: string;
  reconciliationRequired: boolean;
};

export type DeliveryRecord = {
  deliveryId: string;
  sessionId: string;
  teamId: string;
  idempotencyKey: string;
  action: "created" | "prompted";
  sequence: number;
  issueId?: string;
  prompt: string;
  status: DeliveryStatus;
  terminalAcknowledged: boolean;
  openclawSessionId?: string;
  transcriptWatermark?: TranscriptWatermark;
  toolRecovery: ToolRecovery;
  recordedAt: string;
};

/** A frame is retained exactly as received/built; this journal never redacts it. */
export type RelayFrame = Extract<
  OutboundRelayFrame,
  { type: "activity" | "delivery.status" | "rpc.request" }
>;

type ActivityReplayFrame = Extract<RelayFrame, { type: "activity" }>;
type DeliveryStatusReplayFrame = Extract<RelayFrame, { type: "delivery.status" }>;
type RpcReplayFrame = Extract<RelayFrame, { type: "rpc.request" }>;
type DeliveryAcknowledgementFrame = Extract<InboundRelayFrame, { type: "delivery.ack" }>;
export type RpcResultFrame = Extract<InboundRelayFrame, { type: "rpc.result" }>;

export type ReplayEntry = {
  key: string;
  sequence: number;
  kind: "activity" | "delivery_status" | "rpc";
  ownerId: string;
  deliveryId?: string;
  sessionId?: string;
  frame: RelayFrame;
};

export type ReplayEntryInput =
  | {
      key: string;
      kind: "activity";
      deliveryId: string;
      frame: ActivityReplayFrame;
    }
  | {
      key: string;
      kind: "rpc";
      deliveryId?: string;
      frame: RpcReplayFrame;
    }
  | {
      key: string;
      kind: "delivery_status";
      frame: DeliveryStatusReplayFrame;
    };

export type RpcInvocationRecord = {
  invocationId: string;
  semanticFingerprint: string;
  request: RpcReplayFrame;
  deliveryId?: string;
  result?: RpcResultFrame;
};

export type UploadWorkflowStatus = "pending" | "uploading" | "completed" | "failed" | "ambiguous";

export type UploadWorkflow = {
  uploadId: string;
  ownerId: string;
  deliveryId?: string;
  sessionId?: string;
  fileRef: string;
  filename?: string;
  contentType?: string;
  status: UploadWorkflowStatus;
  graphqlCorrelationId?: string;
  idempotencyKey?: string;
  destination?: string;
  bytesSent?: number;
  assetUrl?: string;
  recordedAt: string;
};

type JournalState = {
  version: 1;
  lifecycle: JournalLifecycle;
  nextSequence: number;
  stoppedSessions: Record<string, string>;
  bindings: Record<string, SessionBinding>;
  deliveries: Record<string, DeliveryRecord>;
  replay: ReplayEntry[];
  rpcInvocations: Record<string, RpcInvocationRecord>;
  uploads: Record<string, UploadWorkflow>;
};

export type JournalSnapshot = Readonly<JournalState>;

export type RelayJournalOptions = {
  maxEntries?: number;
  maxBytes?: number;
};

export class JournalError extends Error {
  constructor(message: "Journal state is corrupt" | "Journal state failed validation" | "Journal capacity exceeded" | "Journal I/O failure") {
    super(message);
    this.name = "JournalError";
  }
}

export class JournalCapacityError extends JournalError {
  constructor() {
    super("Journal capacity exceeded");
    this.name = "JournalCapacityError";
  }
}

const ID_LIMIT = 512;
const DATE_LIMIT = 80;
const UTF8 = new TextEncoder();

function emptyState(): JournalState {
  return {
    version: RELAY_JOURNAL_VERSION,
    lifecycle: { fence: "normal" },
    nextSequence: 1,
    stoppedSessions: {},
    bindings: {},
    deliveries: {},
    replay: [],
    rpcInvocations: {},
    uploads: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isString(value: unknown, maximum = ID_LIMIT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isOptionalString(value: unknown, maximum = ID_LIMIT): value is string | undefined {
  return value === undefined || isString(value, maximum);
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isIsoDate(value: unknown): value is string {
  return isString(value, DATE_LIMIT) && /T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value) && !Number.isNaN(Date.parse(value));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateEnrollmentIdentity(value: unknown): value is FencedEnrollmentIdentity {
  return isRecord(value) && hasOnlyKeys(value, ["agentId", "enrollmentGeneration"]) &&
    isString(value.agentId, 128) &&
    isPositiveInteger(value.enrollmentGeneration);
}

function isTerminalDeliveryStatus(status: unknown): status is Extract<
  DeliveryStatus,
  "completed" | "failed" | "canceled"
> {
  return status === "completed" || status === "failed" || status === "canceled";
}

function validateObjectJson(value: unknown): value is JsonObject {
  return isRecord(value) && isJsonValue(value);
}

function validateSessionTarget(value: unknown): value is OpenClawSessionTarget {
  if (!isRecord(value)) return false;
  return isString(value.agentId) && isString(value.sessionId) && isString(value.sessionKey) &&
    isString(value.storePath, 4_096) &&
    (value.threadId === undefined || isString(value.threadId) ||
      (typeof value.threadId === "number" && Number.isFinite(value.threadId)));
}

function validateRouting(value: unknown): value is OpenClawRoutingIdentity {
  if (!isRecord(value)) return false;
  return isString(value.agentId) && value.channel === "unblock-linear" &&
    isString(value.accountId) && isString(value.sessionKey) && isString(value.mainSessionKey) &&
    (value.lastRoutePolicy === "main" || value.lastRoutePolicy === "session") &&
    (value.matchedBy === "binding.peer" || value.matchedBy === "binding.peer.parent" ||
      value.matchedBy === "binding.peer.wildcard" || value.matchedBy === "binding.guild+roles" ||
      value.matchedBy === "binding.guild" || value.matchedBy === "binding.team" ||
      value.matchedBy === "binding.account" || value.matchedBy === "binding.channel" ||
      value.matchedBy === "default") &&
    (value.dmScope === undefined || value.dmScope === "main" || value.dmScope === "per-peer" ||
      value.dmScope === "per-channel-peer" || value.dmScope === "per-account-channel-peer");
}

function validateBinding(value: unknown): value is SessionBinding {
  if (!isRecord(value)) return false;
  if (!isString(value.linearSessionId) || !isString(value.teamId, 128) ||
    !isString(value.openclawSessionId) || !validateSessionTarget(value.sessionTarget) ||
    !validateRouting(value.routing) || !isIsoDate(value.createdAt)) return false;
  return value.openclawSessionId === value.sessionTarget.sessionId &&
    value.sessionTarget.agentId === value.routing.agentId &&
    value.sessionTarget.sessionKey === value.routing.sessionKey;
}

function validateWatermark(value: unknown): value is TranscriptWatermark {
  return isRecord(value) && isOptionalString(value.messageId) && isOptionalString(value.eventId) && isOptionalString(value.turnId);
}

function validateToolRecovery(value: unknown): value is ToolRecovery {
  if (!isRecord(value)) return false;
  return (value.state === "none" || value.state === "started" || value.state === "completed" || value.state === "ambiguous") &&
    isOptionalString(value.toolCallId) && isOptionalString(value.toolName) && typeof value.reconciliationRequired === "boolean";
}

function validateDelivery(value: unknown): value is DeliveryRecord {
  if (!isRecord(value)) return false;
  return isString(value.deliveryId) && isString(value.sessionId) && isString(value.teamId, 128) &&
    isString(value.idempotencyKey) &&
    (value.action === "created" || value.action === "prompted") && isPositiveInteger(value.sequence) &&
    isOptionalString(value.issueId) && typeof value.prompt === "string" && value.prompt.length <= 48_000 &&
    (value.status === "offered" || value.status === "accepted" || value.status === "started" ||
      value.status === "completed" || value.status === "failed" || value.status === "canceled") &&
    typeof value.terminalAcknowledged === "boolean" &&
    (!value.terminalAcknowledged || isTerminalDeliveryStatus(value.status)) &&
    isOptionalString(value.openclawSessionId) && (value.transcriptWatermark === undefined || validateWatermark(value.transcriptWatermark)) &&
    validateToolRecovery(value.toolRecovery) && isIsoDate(value.recordedAt);
}

function validateFrame(value: unknown): value is RelayFrame {
  if (!validateObjectJson(value)) return false;
  const encoded = JSON.stringify(value);
  const encodedBytes = UTF8.encode(encoded).byteLength;
  if (encodedBytes > MAX_RELAY_FRAME_BYTES) return false;
  let parsed: OutboundRelayFrame;
  try {
    parsed = parseOutboundRelayFrame(encoded);
  } catch {
    return false;
  }
  if (parsed.type !== "activity" && parsed.type !== "delivery.status" && parsed.type !== "rpc.request") return false;
  if (!isDeepStrictEqual(parsed, value)) return false;
  if (parsed.type === "rpc.request") {
    if (encodedBytes > MAX_PERSISTED_RPC_BYTES) return false;
    if (parsed.payload.method === "linear.graphql" &&
      UTF8.encode(parsed.payload.params.document).byteLength > 48_000) return false;
  }
  return true;
}

function replayIdentity(
  kind: ReplayEntry["kind"],
  frame: RelayFrame,
  deliveryId: unknown,
): { ownerId: string; deliveryId?: string; sessionId?: string } | undefined {
  if (kind === "delivery_status" && frame.type === "delivery.status" && deliveryId === undefined) {
    return {
      ownerId: frame.payload.deliveryId,
      deliveryId: frame.payload.deliveryId,
      sessionId: frame.sessionId,
    };
  }
  if (kind === "activity" && frame.type === "activity" && isString(deliveryId)) {
    return { ownerId: deliveryId, deliveryId, sessionId: frame.sessionId };
  }
  if (kind !== "rpc" || frame.type !== "rpc.request" || !isOptionalString(deliveryId)) {
    return undefined;
  }
  const ownerId = frame.payload.method === "linear.graphql"
    ? frame.payload.params.contextId
    : frame.sessionId;
  if (ownerId === undefined) return undefined;
  return {
    ownerId,
    ...(deliveryId === undefined ? {} : { deliveryId }),
    ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
  };
}

function validateReplay(value: unknown): value is ReplayEntry {
  if (!isRecord(value)) return false;
  if (!isString(value.key) || !isPositiveInteger(value.sequence) ||
    (value.kind !== "activity" && value.kind !== "delivery_status" && value.kind !== "rpc") || !validateFrame(value.frame)) return false;
  const suppliedDeliveryId = value.kind === "delivery_status" ? undefined : value.deliveryId;
  const identity = replayIdentity(value.kind, value.frame, suppliedDeliveryId);
  return identity !== undefined && value.ownerId === identity.ownerId &&
    value.deliveryId === identity.deliveryId && value.sessionId === identity.sessionId;
}

function validateRpcResult(value: unknown): value is RpcResultFrame {
  if (!validateObjectJson(value)) return false;
  const encoded = JSON.stringify(value);
  if (UTF8.encode(encoded).byteLength > MAX_RELAY_FRAME_BYTES) return false;
  let parsed: InboundRelayFrame;
  try {
    parsed = parseInboundRelayFrame(encoded);
  } catch {
    return false;
  }
  return parsed.type === "rpc.result" && isDeepStrictEqual(parsed, value) &&
    (!parsed.payload.ok || UTF8.encode(JSON.stringify(parsed.payload.result)).byteLength <= 48_000);
}

function validateRpcInvocation(value: unknown): value is RpcInvocationRecord {
  if (!isRecord(value) || !isString(value.invocationId) ||
    typeof value.semanticFingerprint !== "string" ||
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(value.semanticFingerprint) ||
    !validateFrame(value.request) ||
    value.request.type !== "rpc.request" || value.request.payload.method !== "linear.graphql" ||
    !isOptionalString(value.deliveryId) ||
    (value.result !== undefined && !validateRpcResult(value.result))) return false;
  return value.result === undefined ||
    (value.result.correlationId === value.request.correlationId &&
      value.result.agentId === value.request.agentId &&
      value.result.sessionId === value.request.sessionId);
}

function validateUpload(value: unknown): value is UploadWorkflow {
  if (!isRecord(value)) return false;
  return isString(value.uploadId) && isString(value.ownerId) && isString(value.fileRef) &&
    isOptionalString(value.deliveryId) && isOptionalString(value.sessionId, 128) &&
    (value.deliveryId === undefined) === (value.sessionId === undefined) &&
    managedMediaId(value.fileRef) !== undefined && isOptionalString(value.filename) && isOptionalString(value.contentType) &&
    (value.status === "pending" || value.status === "uploading" || value.status === "completed" || value.status === "failed" || value.status === "ambiguous") &&
    isOptionalString(value.graphqlCorrelationId) && isOptionalString(value.idempotencyKey) && isOptionalString(value.destination, 8_192) &&
    (value.bytesSent === undefined || (typeof value.bytesSent === "number" && Number.isSafeInteger(value.bytesSent) && value.bytesSent >= 0)) &&
    isOptionalString(value.assetUrl, 8_192) && isIsoDate(value.recordedAt);
}

function validateState(value: unknown): value is JournalState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.lifecycle) ||
    !hasOnlyKeys(value.lifecycle, ["fence", "generation", "enrollment"]) ||
    (value.lifecycle.fence !== "normal" && value.lifecycle.fence !== "revoked" && value.lifecycle.fence !== "enrollment_replaced") ||
    (value.lifecycle.fence === "normal"
      ? (value.lifecycle.generation !== undefined || value.lifecycle.enrollment !== undefined)
      : (!validateEnrollmentIdentity(value.lifecycle.enrollment) ||
        (value.lifecycle.fence === "enrollment_replaced"
          ? !isPositiveInteger(value.lifecycle.generation)
          : value.lifecycle.generation !== undefined))) ||
    !isPositiveInteger(value.nextSequence) ||
    !isRecord(value.stoppedSessions) || !isRecord(value.bindings) || !isRecord(value.deliveries) || !Array.isArray(value.replay) ||
    !isRecord(value.rpcInvocations) || !isRecord(value.uploads)) return false;
  const replay = value.replay;
  const stoppedSessions = value.stoppedSessions;
  const deliveryEntries = Object.entries(value.deliveries);
  if (!replay.every((entry): entry is ReplayEntry => validateReplay(entry)) ||
    !deliveryEntries.every((entry): entry is [string, DeliveryRecord] =>
      isRecord(entry[1]) && entry[0] === entry[1].deliveryId && validateDelivery(entry[1]))) return false;
  return Object.entries(stoppedSessions).every(([sessionId, stoppedAt]) =>
    isString(sessionId, 128) && isIsoDate(stoppedAt) &&
      deliveryEntries.some(([, delivery]) => delivery.sessionId === sessionId)) &&
    Object.entries(value.bindings).every(([key, entry]) => isRecord(entry) && key === entry.linearSessionId && validateBinding(entry)) &&
    replay.every((entry, index, all) => all.findIndex((candidate) => candidate.key === entry.key) === index) &&
    replay.every((entry, index, all) => index === 0 || entry.sequence > all[index - 1].sequence) &&
    (replay.length === 0 || value.nextSequence > replay[replay.length - 1].sequence) &&
    Object.entries(value.rpcInvocations).every(([key, entry]) =>
      isRecord(entry) && key === entry.invocationId && validateRpcInvocation(entry)) &&
    Object.entries(value.uploads).every(([key, entry]) => isRecord(entry) && key === entry.uploadId && validateUpload(entry));
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function encodedSize(value: JournalState): number {
  return UTF8.encode(JSON.stringify(value)).byteLength;
}

function entryCount(state: JournalState): number {
  return 1 + Object.keys(state.stoppedSessions).length + Object.keys(state.bindings).length + Object.keys(state.deliveries).length +
    state.replay.length + Object.keys(state.rpcInvocations).length + Object.keys(state.uploads).length;
}

function errorFromRead(): JournalError {
  return new JournalError("Journal state is corrupt");
}

function acknowledgeDeliveryStatus(
  state: JournalState,
  frame: DeliveryAcknowledgementFrame,
): DeliveryRecord | undefined {
  const delivery = state.deliveries[frame.payload.deliveryId];
  if (delivery === undefined) return undefined;
  if (delivery.sessionId !== frame.sessionId || delivery.idempotencyKey !== frame.idempotencyKey) {
    throw new JournalError("Journal state failed validation");
  }
  const replayIndex = state.replay.findIndex((entry) =>
    entry.kind === "delivery_status" &&
    entry.frame.type === "delivery.status" &&
    entry.frame.payload.deliveryId === frame.payload.deliveryId &&
    entry.frame.payload.status === frame.payload.status &&
    entry.frame.sessionId === frame.sessionId &&
    entry.frame.idempotencyKey === frame.idempotencyKey);
  if (replayIndex === -1) {
    if (frame.payload.status === "canceled" && state.stoppedSessions[delivery.sessionId] !== undefined) {
      delivery.status = "canceled";
      delivery.terminalAcknowledged = true;
      return delivery;
    }
    const alreadyAcknowledged = delivery.status === frame.payload.status &&
      (!isTerminalDeliveryStatus(frame.payload.status) || delivery.terminalAcknowledged);
    if (!alreadyAcknowledged) throw new JournalError("Journal state failed validation");
    return delivery;
  }

  state.replay.splice(replayIndex, 1);
  if (isTerminalDeliveryStatus(frame.payload.status)) {
    delivery.status = frame.payload.status;
    delivery.terminalAcknowledged = true;
  } else if (!isTerminalDeliveryStatus(delivery.status)) {
    delivery.status = frame.payload.status;
  }
  return delivery;
}

function compactAcknowledgedDelivery(state: JournalState, delivery: DeliveryRecord): void {
  state.replay = state.replay.filter((entry) =>
    entry.deliveryId !== delivery.deliveryId || entry.kind === "rpc");
  delete state.deliveries[delivery.deliveryId];
  for (const [uploadId, upload] of Object.entries(state.uploads)) {
    if (upload.deliveryId === delivery.deliveryId && upload.status === "completed") {
      delete state.uploads[uploadId];
    }
  }
  compactStoppedSessionIfSafe(state, delivery.sessionId);
}

function compactStoppedSessionIfSafe(state: JournalState, sessionId: string): void {
  if (state.stoppedSessions[sessionId] === undefined || Object.values(state.deliveries).some(
    (delivery) => delivery.sessionId === sessionId,
  )) return;
  compactStoppedSession(state, sessionId);
}

function compactStoppedSession(state: JournalState, sessionId: string): void {
  delete state.stoppedSessions[sessionId];
  delete state.bindings[sessionId];
  state.replay = state.replay.filter((entry) => entry.sessionId !== sessionId || entry.kind === "rpc");
}

function removeSessionRpcs(state: JournalState, sessionId: string): void {
  state.replay = state.replay.filter((entry) => entry.kind !== "rpc" || entry.sessionId !== sessionId);
  for (const [invocationId, invocation] of Object.entries(state.rpcInvocations)) {
    if (invocation.request.sessionId === sessionId) delete state.rpcInvocations[invocationId];
  }
}

export class RelayJournal {
  private state: JournalState;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private mutation = Promise.resolve();

  private constructor(private readonly path: string, options: RelayJournalOptions, state: JournalState) {
    this.maxEntries = options.maxEntries ?? DEFAULT_JOURNAL_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_JOURNAL_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new JournalError("Journal state failed validation");
    }
    this.state = state;
  }

  static async open(path: string, options: RelayJournalOptions = {}): Promise<RelayJournal> {
    if (!isString(path, 4096)) throw new JournalError("Journal state failed validation");
    const state = await RelayJournal.read(path);
    const journal = new RelayJournal(path, options, state);
    journal.assertWithinBounds(state);
    await journal.persist(state);
    return journal;
  }

  private static async read(path: string): Promise<JournalState> {
    const readOne = async (source: string): Promise<JournalState | undefined> => {
      try {
        const parsed: unknown = JSON.parse(await readFile(source, "utf8"));
        if (!validateState(parsed)) throw errorFromRead();
        await chmod(source, 0o600);
        return parsed;
      } catch (error) {
        if (isNodeNotFound(error)) return undefined;
        throw errorFromRead();
      }
    };
    const primary = await readOne(path);
    if (primary !== undefined) {
      try {
        await unlink(`${path}.tmp`);
      } catch (error) {
        if (!isNodeNotFound(error)) throw new JournalError("Journal I/O failure");
      }
      return primary;
    }
    return await readOne(`${path}.tmp`) ?? emptyState();
  }

  private assertWithinBounds(state: JournalState): void {
    const capacityState = { ...state, stoppedSessions: {} };
    if (entryCount(capacityState) > this.maxEntries || encodedSize(capacityState) > this.maxBytes) {
      throw new JournalCapacityError();
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(next: JournalState): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      const temporaryFile = await open(temporary, "w", 0o600);
      try {
        await temporaryFile.writeFile(JSON.stringify(next), { encoding: "utf8" });
        await temporaryFile.chmod(0o600);
        await temporaryFile.sync();
      } finally {
        await temporaryFile.close();
      }
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      try {
        const directory = await open(dirname(this.path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        if (!isDirectorySyncUnsupported(error)) throw error;
      }
    } catch {
      throw new JournalError("Journal I/O failure");
    }
  }

  private mutate<T>(operation: (state: JournalState) => T): Promise<T> {
    return this.enqueue(async () => {
      const next = clone(this.state);
      const result = operation(next);
      if (!validateState(next)) throw new JournalError("Journal state failed validation");
      this.assertWithinBounds(next);
      await this.persist(next);
      this.state = next;
      return clone(result);
    });
  }

  snapshot(): JournalSnapshot {
    return clone(this.state);
  }

  getLifecycle(): JournalState["lifecycle"] {
    return clone(this.state.lifecycle);
  }

  getBinding(linearSessionId: string): SessionBinding | undefined {
    return clone(this.state.bindings[linearSessionId]);
  }

  getDelivery(deliveryId: string): DeliveryRecord | undefined {
    return clone(this.state.deliveries[deliveryId]);
  }

  getReplayEntries(ownerId?: string): ReplayEntry[] {
    return clone(ownerId === undefined ? this.state.replay : this.state.replay.filter((entry) => entry.ownerId === ownerId));
  }

  getRpcInvocation(invocationId: string): RpcInvocationRecord | undefined {
    return clone(this.state.rpcInvocations[invocationId]);
  }

  getUpload(uploadId: string): UploadWorkflow | undefined {
    return clone(this.state.uploads[uploadId]);
  }

  setLifecycle(...input:
    | [fence: "normal"]
    | [fence: "revoked", enrollment: FencedEnrollmentIdentity]
    | [fence: "enrollment_replaced", generation: number, enrollment: FencedEnrollmentIdentity]
  ): Promise<void> {
    return this.mutate((state) => {
      state.lifecycle = input[0] === "normal"
        ? { fence: input[0] }
        : input[0] === "revoked"
          ? { fence: input[0], enrollment: input[1] }
          : { fence: input[0], generation: input[1], enrollment: input[2] };
    });
  }

  activateReplacement(enrollment: FencedEnrollmentIdentity): Promise<void> {
    return this.mutate((state) => {
      const lifecycle = state.lifecycle;
      if (lifecycle.fence === "normal" ||
        lifecycle.enrollment.agentId !== enrollment.agentId ||
        enrollment.enrollmentGeneration <= lifecycle.enrollment.enrollmentGeneration ||
        (lifecycle.fence === "enrollment_replaced" && enrollment.enrollmentGeneration < lifecycle.generation)) {
        throw new JournalError("Journal state failed validation");
      }

      const validateFrameAgent = (frame: RelayFrame | RpcResultFrame): void => {
        if (frame.agentId !== enrollment.agentId) {
          throw new JournalError("Journal state failed validation");
        }
      };

      for (const entry of state.replay) validateFrameAgent(entry.frame);
      for (const invocation of Object.values(state.rpcInvocations)) {
        validateFrameAgent(invocation.request);
        if (invocation.result !== undefined) validateFrameAgent(invocation.result);
      }
      state.lifecycle = { fence: "normal" };
    });
  }

  bindSession(binding: SessionBinding): Promise<SessionBinding> {
    return this.mutate((state) => {
      const prior = state.bindings[binding.linearSessionId];
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(binding)) throw new JournalError("Journal state failed validation");
      state.bindings[binding.linearSessionId] = binding;
      return binding;
    });
  }

  recordDelivery(delivery: DeliveryRecord): Promise<DeliveryRecord> {
    return this.mutate((state) => {
      const prior = state.deliveries[delivery.deliveryId];
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(delivery)) throw new JournalError("Journal state failed validation");
      state.deliveries[delivery.deliveryId] = delivery;
      return delivery;
    });
  }

  updateDelivery(
    deliveryId: string,
    patch: Partial<Pick<
      DeliveryRecord,
      "status" | "terminalAcknowledged" | "openclawSessionId" | "transcriptWatermark" | "toolRecovery"
    >>,
  ): Promise<DeliveryRecord> {
    return this.mutate((state) => {
      if (!hasOnlyKeys(patch, [
        "status",
        "terminalAcknowledged",
        "openclawSessionId",
        "transcriptWatermark",
        "toolRecovery",
      ])) throw new JournalError("Journal state failed validation");
      const prior = state.deliveries[deliveryId];
      if (prior === undefined) throw new JournalError("Journal state failed validation");
      const next = { ...prior, ...patch, deliveryId };
      state.deliveries[deliveryId] = next;
      return next;
    });
  }

  addReplay(entry: ReplayEntryInput): Promise<ReplayEntry> {
    return this.mutate((state) => {
      const suppliedDeliveryId = entry.kind === "delivery_status" ? undefined : entry.deliveryId;
      const identity = replayIdentity(entry.kind, entry.frame, suppliedDeliveryId);
      if (identity === undefined) throw new JournalError("Journal state failed validation");
      const candidate: Omit<ReplayEntry, "sequence"> = {
        ...entry,
        ...identity,
      };
      const prior = state.replay.find((candidate) => candidate.key === entry.key);
      if (prior !== undefined) {
        const { sequence: _sequence, ...priorWithoutSequence } = prior;
        if (!isDeepStrictEqual(priorWithoutSequence, candidate)) {
          throw new JournalError("Journal state failed validation");
        }
        return prior;
      }
      const next = { ...candidate, sequence: state.nextSequence++ };
      state.replay.push(next);
      return next;
    });
  }

  removeReplay(key: string): Promise<void> {
    return this.mutate((state) => {
      state.replay = state.replay.filter((entry) => entry.key !== key);
    });
  }

  recordRpcInvocation(
    invocationId: string,
    semanticFingerprint: string,
    request: RpcReplayFrame,
    deliveryId?: string,
  ): Promise<RpcInvocationRecord> {
    return this.mutate((state) => {
      const candidate: RpcInvocationRecord = {
        invocationId,
        semanticFingerprint,
        request,
        ...(deliveryId === undefined ? {} : { deliveryId }),
      };
      const prior = state.rpcInvocations[invocationId];
      if (prior !== undefined) {
        if (prior.semanticFingerprint !== semanticFingerprint ||
          !isDeepStrictEqual(prior.request, request) || prior.deliveryId !== deliveryId) {
          throw new JournalError("Journal state failed validation");
        }
        return prior;
      }
      if (!validateRpcInvocation(candidate)) throw new JournalError("Journal state failed validation");
      const identity = replayIdentity("rpc", request, deliveryId);
      if (identity === undefined) throw new JournalError("Journal state failed validation");
      state.rpcInvocations[invocationId] = candidate;
      state.replay.push({
        key: `rpc:${request.correlationId}`,
        sequence: state.nextSequence++,
        kind: "rpc",
        frame: request,
        ...identity,
      });
      return candidate;
    });
  }

  recordRpcResult(result: RpcResultFrame): Promise<RpcInvocationRecord> {
    return this.mutate((state) => {
      if (!validateRpcResult(result)) throw new JournalError("Journal state failed validation");
      const matches = Object.values(state.rpcInvocations).filter(
        (entry) => entry.request.correlationId === result.correlationId,
      );
      if (matches.length !== 1) throw new JournalError("Journal state failed validation");
      const invocation = matches[0];
      if (result.agentId !== invocation.request.agentId ||
        result.sessionId !== invocation.request.sessionId) {
        throw new JournalError("Journal state failed validation");
      }
      if (invocation.result !== undefined && !isDeepStrictEqual(invocation.result, result)) {
        throw new JournalError("Journal state failed validation");
      }
      invocation.result = result;
      return invocation;
    });
  }

  retryRpcInvocation(invocationId: string): Promise<RpcInvocationRecord> {
    return this.mutate((state) => {
      const invocation = state.rpcInvocations[invocationId];
      if (invocation === undefined || invocation.result === undefined || invocation.result.payload.ok ||
        !invocation.result.payload.error.retryable) {
        throw new JournalError("Journal state failed validation");
      }
      delete invocation.result;
      const replayKey = `rpc:${invocation.request.correlationId}`;
      if (!state.replay.some((entry) => entry.key === replayKey)) {
        const identity = replayIdentity("rpc", invocation.request, invocation.deliveryId);
        if (identity === undefined) throw new JournalError("Journal state failed validation");
        state.replay.push({
          key: replayKey,
          sequence: state.nextSequence++,
          kind: "rpc",
          frame: invocation.request,
          ...identity,
        });
      }
      return invocation;
    });
  }

  consumeRpcInvocation(invocationId: string): Promise<void> {
    return this.mutate((state) => {
      const invocation = state.rpcInvocations[invocationId];
      if (invocation === undefined || invocation.result === undefined) {
        throw new JournalError("Journal state failed validation");
      }
      delete state.rpcInvocations[invocationId];
      state.replay = state.replay.filter(
        (entry) => entry.kind !== "rpc" || entry.frame.type !== "rpc.request" ||
          entry.frame.correlationId !== invocation.request.correlationId,
      );
    });
  }

  acknowledgeDeliveryStatus(frame: DeliveryAcknowledgementFrame): Promise<void> {
    return this.mutate((state) => {
      acknowledgeDeliveryStatus(state, frame);
    });
  }

  acknowledgeAndCompactDeliveryStatus(frame: DeliveryAcknowledgementFrame): Promise<void> {
    return this.mutate((state) => {
      const delivery = acknowledgeDeliveryStatus(state, frame);
      if (delivery !== undefined && isTerminalDeliveryStatus(frame.payload.status)) {
        compactAcknowledgedDelivery(state, delivery);
      }
    });
  }

  recordUpload(upload: UploadWorkflow): Promise<UploadWorkflow> {
    return this.mutate((state) => {
      const prior = state.uploads[upload.uploadId];
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(upload)) throw new JournalError("Journal state failed validation");
      state.uploads[upload.uploadId] = upload;
      return upload;
    });
  }

  updateUpload(
    uploadId: string,
    patch: Partial<Pick<
      UploadWorkflow,
      "status" | "graphqlCorrelationId" | "idempotencyKey" | "destination" | "bytesSent" | "assetUrl"
    >>,
  ): Promise<UploadWorkflow> {
    return this.mutate((state) => {
      if (!hasOnlyKeys(patch, [
        "status",
        "graphqlCorrelationId",
        "idempotencyKey",
        "destination",
        "bytesSent",
        "assetUrl",
      ])) throw new JournalError("Journal state failed validation");
      const prior = state.uploads[uploadId];
      if (prior === undefined) throw new JournalError("Journal state failed validation");
      const next = { ...prior, ...patch, uploadId };
      state.uploads[uploadId] = next;
      return next;
    });
  }

  compactAcknowledgedDelivery(deliveryId: string): Promise<void> {
    return this.mutate((state) => {
      const delivery = state.deliveries[deliveryId];
      if (delivery === undefined || !isTerminalDeliveryStatus(delivery.status) ||
        !delivery.terminalAcknowledged) {
        throw new JournalError("Journal state failed validation");
      }
      compactAcknowledgedDelivery(state, delivery);
    });
  }

  compactCompletedUpload(uploadId: string): Promise<void> {
    return this.mutate((state) => {
      const upload = state.uploads[uploadId];
      if (upload === undefined || upload.status !== "completed") {
        throw new JournalError("Journal state failed validation");
      }
      delete state.uploads[uploadId];
    });
  }

  compactStoppedSession(sessionId: string): Promise<void> {
    return this.mutate((state) => {
      if (!isString(sessionId, 128)) throw new JournalError("Journal state failed validation");
      const deliveries = Object.values(state.deliveries).filter(
        (delivery) => delivery.sessionId === sessionId,
      );
      if (deliveries.some((delivery) =>
        !isTerminalDeliveryStatus(delivery.status) || !delivery.terminalAcknowledged)) {
        throw new JournalError("Journal state failed validation");
      }
      for (const delivery of deliveries) compactAcknowledgedDelivery(state, delivery);
      compactStoppedSession(state, sessionId);
    });
  }

  markSessionStopped(sessionId: string, stoppedAt: string): Promise<void> {
    return this.mutate((state) => {
      if (!isString(sessionId, 128) || !isIsoDate(stoppedAt)) {
        throw new JournalError("Journal state failed validation");
      }
      removeSessionRpcs(state, sessionId);
      if (Object.values(state.deliveries).some((delivery) => delivery.sessionId === sessionId)) {
        state.stoppedSessions[sessionId] ??= stoppedAt;
      } else {
        compactStoppedSession(state, sessionId);
      }
    });
  }

  removeCanceledSessionRpcs(sessionId: string): Promise<void> {
    return this.mutate((state) => {
      if (!isString(sessionId, 128)) throw new JournalError("Journal state failed validation");
      removeSessionRpcs(state, sessionId);
    });
  }

  cancelAllRpcInvocations(): Promise<void> {
    return this.mutate((state) => {
      state.replay = state.replay.filter((entry) => entry.kind !== "rpc");
      state.rpcInvocations = {};
    });
  }
}

function isNodeNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isDirectorySyncUnsupported(error: unknown): boolean {
  return isRecord(error) &&
    (error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EISDIR" ||
      error.code === "EPERM");
}
