import { z } from "zod";

/**
 * Vendored verbatim from unblocked-linear-worker/src/protocol/relay.ts.
 * Keep the schema body synchronized with the Worker; plugin-only direction
 * helpers are appended below the Worker implementation.
 */

const MAX_RELAY_FRAME_BYTES = 64 * 1024;

const identifier = z.string().trim().min(1).max(128);
const uuid = z.string().uuid();
const boundedText = (maximum: number) => z.string().max(maximum);

const envelope = z.object({
  v: z.literal(1),
  id: uuid,
  agentId: identifier,
  deviceId: identifier,
  timestamp: z.string().datetime({ offset: true }),
});

export const agentActivityCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thought"), body: boundedText(4_000), ephemeral: z.boolean().optional() }),
  z.object({
    type: z.literal("action"),
    action: boundedText(256),
    parameter: boundedText(2_000),
    result: boundedText(4_000).optional(),
    ephemeral: z.boolean().optional(),
  }),
  z.object({ type: z.literal("elicitation"), body: boundedText(8_000) }),
  z.object({ type: z.literal("response"), body: boundedText(32_000) }),
  z.object({ type: z.literal("error"), body: boundedText(8_000) }),
]);

export type AgentActivityCommand = z.infer<typeof agentActivityCommandSchema>;

const deliveryFrameSchema = envelope.extend({
  type: z.literal("delivery"),
  sessionId: identifier,
  idempotencyKey: identifier,
  payload: z.object({
    deliveryId: uuid,
    action: z.enum(["created", "prompted"]),
    sequence: z.number().int().positive(),
    issueId: identifier.optional(),
    teamId: identifier,
    openclawSessionId: identifier.optional(),
    prompt: boundedText(48_000),
  }),
});

const controlFrameSchema = envelope.extend({
  type: z.literal("control"),
  sessionId: identifier.optional(),
  payload: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("session.stop"), reason: boundedText(1_000).optional() }),
    z.object({ kind: z.literal("team.access_removed"), teamId: identifier }),
    z.object({ kind: z.literal("installation.revoked") }),
    z.object({ kind: z.literal("device.replaced"), generation: z.number().int().nonnegative() }),
  ]),
});

const rpcResultFrameSchema = envelope.extend({
  type: z.literal("rpc.result"),
  correlationId: uuid,
  sessionId: identifier.optional(),
  payload: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), result: z.json() }),
    z.object({
      ok: z.literal(false),
      error: z.object({
        code: z.enum([
          "invalid_request",
          "unauthorized",
          "not_found",
          "conflict",
          "retryable",
          "outcome_unknown",
          "internal",
        ]),
        message: boundedText(1_000),
        retryable: z.boolean(),
      }),
    }),
  ]),
});

const deliveryAcceptFrameSchema = envelope.extend({
  type: z.literal("delivery.accept"),
  sessionId: identifier,
  idempotencyKey: identifier,
  payload: z.object({ deliveryId: uuid, openclawSessionId: identifier.optional() }),
});

const deliveryStatusFrameSchema = envelope.extend({
  type: z.literal("delivery.status"),
  sessionId: identifier,
  idempotencyKey: identifier,
  payload: z.object({
    deliveryId: uuid,
    status: z.enum(["started", "completed", "failed", "canceled"]),
    summary: boundedText(4_000).optional(),
  }),
});

const deliveryAcknowledgementFrameSchema = envelope.extend({
  type: z.literal("delivery.ack"),
  sessionId: identifier,
  idempotencyKey: identifier,
  payload: z.object({
    deliveryId: uuid,
    status: z.enum(["started", "completed", "failed", "canceled"]),
  }),
});

const activityFrameSchema = envelope.extend({
  type: z.literal("activity"),
  sessionId: identifier,
  idempotencyKey: identifier,
  payload: z.object({ commandId: uuid, activity: agentActivityCommandSchema }),
});

const rpcRequestFrameSchema = envelope.extend({
  type: z.literal("rpc.request"),
  sessionId: identifier.optional(),
  correlationId: uuid,
  idempotencyKey: identifier,
  payload: z.object({
    method: z.literal("linear.graphql"),
    params: z.object({
      contextId: identifier,
      operationName: identifier.optional(),
      document: z.string().min(1),
      variables: z.record(z.string(), z.json()),
    }),
  }),
});

export const relayFrameSchema = z.discriminatedUnion("type", [
  deliveryFrameSchema,
  controlFrameSchema,
  rpcResultFrameSchema,
  deliveryAcceptFrameSchema,
  deliveryStatusFrameSchema,
  deliveryAcknowledgementFrameSchema,
  activityFrameSchema,
  rpcRequestFrameSchema,
]);

export type RelayFrame = z.infer<typeof relayFrameSchema>;

export function parseRelayFrame(raw: string | ArrayBuffer, maximumBytes = MAX_RELAY_FRAME_BYTES): RelayFrame {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw);
  if (bytes.byteLength > maximumBytes) {
    throw new RelayProtocolError("frame_too_large", `Relay frame exceeds ${maximumBytes} bytes`);
  }

  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RelayProtocolError("invalid_json", "Relay frame is not valid UTF-8 JSON");
  }

  const parsed = relayFrameSchema.safeParse(value);
  if (!parsed.success) {
    throw new RelayProtocolError("invalid_frame", "Relay frame does not match protocol v1");
  }
  return parsed.data;
}

export class RelayProtocolError extends Error {
  constructor(
    readonly code: "frame_too_large" | "invalid_json" | "invalid_frame",
    message: string,
  ) {
    super(message);
    this.name = "RelayProtocolError";
  }
}

export type InboundRelayFrame = Extract<RelayFrame, {
  type: "delivery" | "control" | "rpc.result" | "delivery.ack";
}>;
export type OutboundRelayFrame = Exclude<RelayFrame, InboundRelayFrame>;

export class UnexpectedRelayFrameDirectionError extends Error {
  constructor(readonly frameType: RelayFrame["type"]) {
    super(`Unexpected relay frame direction: ${frameType}`);
    this.name = "UnexpectedRelayFrameDirectionError";
  }
}

export function isInboundRelayFrame(frame: RelayFrame): frame is InboundRelayFrame {
  return frame.type === "delivery" || frame.type === "control" || frame.type === "rpc.result" || frame.type === "delivery.ack";
}

export function isOutboundRelayFrame(frame: RelayFrame): frame is OutboundRelayFrame {
  return !isInboundRelayFrame(frame);
}

export function parseInboundRelayFrame(raw: string | ArrayBuffer, maximumBytes = MAX_RELAY_FRAME_BYTES): InboundRelayFrame {
  const frame = parseRelayFrame(raw, maximumBytes);
  if (!isInboundRelayFrame(frame)) throw new UnexpectedRelayFrameDirectionError(frame.type);
  return frame;
}

export function parseOutboundRelayFrame(raw: string | ArrayBuffer, maximumBytes = MAX_RELAY_FRAME_BYTES): OutboundRelayFrame {
  const frame = parseRelayFrame(raw, maximumBytes);
  if (!isOutboundRelayFrame(frame)) throw new UnexpectedRelayFrameDirectionError(frame.type);
  return frame;
}

// Kept for the plugin journal's bounded persistence check; the Worker keeps it private.
export { MAX_RELAY_FRAME_BYTES };
