import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/core";
import { z } from "zod";
import {
  parseInboundRelayFrame,
  parseOutboundRelayFrame,
  type InboundRelayFrame,
  type OutboundRelayFrame,
} from "../relay/protocol.js";
import { MANAGED_MEDIA_REF_PATTERN } from "./media-ref.js";
import {
  resolveLinearRunBinding,
  type LinearRunBinding,
} from "./run-binding.js";
import {
  executeManagedUpload,
  linearFileUploadGraphqlInput,
  type ManagedUploadDependencies,
} from "./upload.js";

const MAX_GRAPHQL_DOCUMENT_BYTES = 48_000;
const MAX_PERSISTED_RPC_BYTES = 60 * 1024;
const UTF8 = new TextEncoder();

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { [key: string]: JsonValue } | JsonValue[];

export type LinearToolInput =
  | {
      action: "graphql";
      document: string;
      variables?: Record<string, JsonValue>;
      operationName?: string;
    }
  | {
      action: "upload";
      fileRef: string;
      filename?: string;
      contentType?: string;
    };

type RpcRequestFrame = Extract<OutboundRelayFrame, { type: "rpc.request" }>;
export type LinearGraphqlRpcRequest = Omit<RpcRequestFrame, "payload"> & {
  payload: Extract<RpcRequestFrame["payload"], { method: "linear.graphql" }>;
};
export type LinearRpcResult = Extract<InboundRelayFrame, { type: "rpc.result" }>;

export type RelayIdentity = {
  agentId: string;
  deviceId: string;
};

/**
 * The relay service implements this small durability boundary. It must retain
 * the exact persisted request until consumeResult succeeds. Reconnect and any
 * retryable resend use the same complete request, including both identities.
 */
export interface DurableRpcPort {
  getRelayIdentity(): RelayIdentity;
  getOrCreateRequest(
    invocationId: string,
    semanticFingerprint: string,
    create: () => LinearGraphqlRpcRequest,
    deliveryId?: string,
  ): Promise<LinearGraphqlRpcRequest>;
  executePersisted(
    invocationId: string,
    request: LinearGraphqlRpcRequest,
    signal?: AbortSignal,
  ): Promise<LinearRpcResult>;
  consumeResult(invocationId: string, result: LinearRpcResult): Promise<void>;
}

export type LinearToolIdentitySource = {
  uuid(): string;
  now(): string;
};

export type LinearToolDependencies = {
  rpc: DurableRpcPort;
  identity?: LinearToolIdentitySource;
  upload?: Omit<ManagedUploadDependencies, "requestFileUpload">;
};

export type LinearToolErrorCode =
  | "invalid_input"
  | "not_available"
  | "state_unavailable"
  | "invalid_request"
  | "unauthorized"
  | "retryable"
  | "outcome_unknown"
  | "request_failed";

export class LinearToolError extends Error {
  constructor(
    readonly code: LinearToolErrorCode,
    message: string,
    readonly retryable = false,
    readonly reconciliationRequired = false,
  ) {
    super(message);
    this.name = "LinearToolError";
  }
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const graphqlInputSchema = z.strictObject({
  action: z.literal("graphql"),
  document: z.string().min(1),
  variables: z.record(z.string(), jsonValueSchema).optional(),
  operationName: z.string().min(1).max(128).optional(),
});

const uploadInputSchema = z.strictObject({
  action: z.literal("upload"),
  fileRef: z.string().regex(new RegExp(MANAGED_MEDIA_REF_PATTERN, "u")),
  filename: z.string().min(1).max(512).optional(),
  contentType: z.string().min(1).max(256).optional(),
});

const linearToolInputSchema = z.discriminatedUnion("action", [
  graphqlInputSchema,
  uploadInputSchema,
]);

/** Model-facing JSON Schema. Runtime input is validated again before use. */
export const linearToolParameters = {
  type: "object",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "document"],
      properties: {
        action: { const: "graphql" },
        document: { type: "string", minLength: 1 },
        variables: { type: "object", additionalProperties: true },
        operationName: { type: "string", minLength: 1, maxLength: 128 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "fileRef"],
      properties: {
        action: { const: "upload" },
        fileRef: { type: "string", pattern: MANAGED_MEDIA_REF_PATTERN },
        filename: { type: "string", minLength: 1, maxLength: 512 },
        contentType: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
  ],
} as const;

function contextIdFor(context: OpenClawPluginToolContext, binding: LinearRunBinding | undefined): string {
  if (binding !== undefined) return binding.contextId;
  const conversationIdentity = context.sessionId ?? context.sessionKey;
  if (conversationIdentity === undefined || conversationIdentity.length === 0) {
    throw stateUnavailable();
  }
  const digest = createHash("sha256")
    .update("unblock-linear-context-v1\0")
    .update(context.agentId ?? "")
    .update("\0")
    .update(conversationIdentity)
    .digest("base64url");
  return `oc_${digest}`;
}

function stateUnavailable(): LinearToolError {
  return new LinearToolError(
    "state_unavailable",
    "Linear is unavailable for this run. Check the plugin connection state.",
  );
}

function parseToolInput(value: unknown): LinearToolInput {
  try {
    const parsed = linearToolInputSchema.parse(value);
    if (parsed.action === "graphql" &&
      UTF8.encode(parsed.document).byteLength > MAX_GRAPHQL_DOCUMENT_BYTES) {
      throw new Error("document too large");
    }
    return parsed;
  } catch {
    throw new LinearToolError("invalid_input", "Invalid Linear tool request.");
  }
}

function createGraphqlRequest(
  input: Extract<LinearToolInput, { action: "graphql" }>,
  context: OpenClawPluginToolContext,
  rpc: DurableRpcPort,
  identity: LinearToolIdentitySource,
  runBinding: LinearRunBinding | undefined,
): LinearGraphqlRpcRequest {
  const relayIdentity = rpc.getRelayIdentity();
  const candidate: LinearGraphqlRpcRequest = {
    v: 1,
    id: identity.uuid(),
    type: "rpc.request",
    agentId: relayIdentity.agentId,
    deviceId: relayIdentity.deviceId,
    timestamp: identity.now(),
    ...(runBinding === undefined ? {} : { sessionId: runBinding.linearSessionId }),
    correlationId: identity.uuid(),
    idempotencyKey: identity.uuid(),
    payload: {
      method: "linear.graphql",
      params: {
        contextId: contextIdFor(context, runBinding),
        ...(input.operationName === undefined ? {} : { operationName: input.operationName }),
        document: input.document,
        variables: input.variables ?? {},
      },
    },
  };

  let parsed: OutboundRelayFrame;
  try {
    parsed = parseOutboundRelayFrame(JSON.stringify(candidate), MAX_PERSISTED_RPC_BYTES);
  } catch {
    throw new LinearToolError("invalid_input", "Invalid Linear tool request.");
  }
  if (parsed.type !== "rpc.request" || parsed.payload.method !== "linear.graphql" ||
    !isDeepStrictEqual(parsed, candidate)) {
    throw new LinearToolError("invalid_input", "Invalid Linear tool request.");
  }
  return candidate;
}

function durableRpcIdentity(
  toolCallId: string,
  action: LinearToolInput["action"],
  input: Extract<LinearToolInput, { action: "graphql" }>,
  context: OpenClawPluginToolContext,
  runBinding: LinearRunBinding | undefined,
): { invocationId: string; semanticFingerprint: string } {
  const contextId = contextIdFor(context, runBinding);
  const invocationDigest = createHash("sha256")
    .update("unblock-linear-rpc-invocation-v1\0")
    .update(contextId)
    .update("\0")
    .update(toolCallId)
    .digest("base64url");
  const semantics: JsonValue = {
    action,
    contextId,
    sessionId: runBinding?.linearSessionId ?? null,
    operationName: input.operationName ?? null,
    document: input.document,
    variables: input.variables ?? {},
  };
  const semanticDigest = createHash("sha256")
    .update("unblock-linear-rpc-semantics-v1\0")
    .update(canonicalJson(semantics))
    .digest("base64url");
  return {
    invocationId: `rpc_${invocationDigest}`,
    semanticFingerprint: `sha256:${semanticDigest}`,
  };
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(",")}}`;
}

function validateRpcResult(request: LinearGraphqlRpcRequest, value: LinearRpcResult): LinearRpcResult {
  let parsed: InboundRelayFrame;
  try {
    parsed = parseInboundRelayFrame(JSON.stringify(value));
  } catch {
    throw stateUnavailable();
  }
  if (parsed.type !== "rpc.result" || parsed.correlationId !== request.correlationId ||
    !isDeepStrictEqual(parsed, value)) {
    throw stateUnavailable();
  }
  return value;
}

function mapRpcFailure(error: Extract<LinearRpcResult["payload"], { ok: false }>["error"]): never {
  if (error.code === "invalid_request") {
    throw new LinearToolError("invalid_request", "Linear rejected the GraphQL request as invalid.");
  }
  if (error.code === "unauthorized") {
    throw new LinearToolError(
      "unauthorized",
      "Linear authorization is unavailable. Reauthorize and reconnect the plugin.",
    );
  }
  if (error.code === "outcome_unknown") {
    throw new LinearToolError(
      "outcome_unknown",
      "The Linear mutation outcome is unknown. Reconcile it with a read query before trying another mutation.",
      false,
      true,
    );
  }
  if (error.retryable) {
    throw new LinearToolError(
      "retryable",
      "Linear is temporarily unavailable. Retry the same durable request.",
      true,
    );
  }
  throw new LinearToolError("request_failed", "The Linear request failed.");
}

export function createLinearTool(
  dependencies: LinearToolDependencies,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  const identity = dependencies.identity ?? {
    uuid: randomUUID,
    now: () => new Date().toISOString(),
  };

  const executeGraphql = async (
    toolCallId: string,
    action: LinearToolInput["action"],
    input: Extract<LinearToolInput, { action: "graphql" }>,
    runBinding: LinearRunBinding | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const { invocationId, semanticFingerprint } = durableRpcIdentity(
      toolCallId,
      action,
      input,
      context,
      runBinding,
    );
    const request = await dependencies.rpc.getOrCreateRequest(
      invocationId,
      semanticFingerprint,
      () => createGraphqlRequest(input, context, dependencies.rpc, identity, runBinding),
      runBinding?.deliveryId,
    );
    const result = validateRpcResult(
      request,
      await dependencies.rpc.executePersisted(invocationId, request, signal),
    );

    if (!result.payload.ok && (result.payload.error.retryable || result.payload.error.code === "unauthorized")) {
      mapRpcFailure(result.payload.error);
    }
    await dependencies.rpc.consumeResult(invocationId, result);
    if (!result.payload.ok) mapRpcFailure(result.payload.error);
    return result.payload.result;
  };

  return {
    name: "linear",
    label: "Linear",
    description: "Query or mutate Linear, or upload OpenClaw-managed media through the connected installation.",
    parameters: linearToolParameters,
    async execute(_toolCallId, value, signal) {
      const input = parseToolInput(value);
      let runBinding: LinearRunBinding | undefined;
      try {
        runBinding = resolveLinearRunBinding(context);
      } catch {
        throw stateUnavailable();
      }
      if (input.action === "upload") {
        if (dependencies.upload === undefined) {
          throw new LinearToolError("not_available", "Linear managed file upload is not available yet.");
        }
        const uploaded = await executeManagedUpload({
          toolCallId: _toolCallId,
          ownerId: contextIdFor(context, runBinding),
          ...(runBinding === undefined ? {} : {
            deliveryId: runBinding.deliveryId,
            sessionId: runBinding.linearSessionId,
          }),
          fileRef: input.fileRef,
          ...(input.filename === undefined ? {} : { filename: input.filename }),
          ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
          ...(signal === undefined ? {} : { signal }),
        }, {
          ...dependencies.upload,
          requestFileUpload: (request) => executeGraphql(
            request.invocationId,
            "upload",
            linearFileUploadGraphqlInput(request),
            runBinding,
            request.signal,
          ),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(uploaded) }],
          details: uploaded,
        };
      }

      const graphqlResult = await executeGraphql(_toolCallId, "graphql", input, runBinding, signal);

      return {
        content: [{ type: "text", text: JSON.stringify(graphqlResult) }],
        details: graphqlResult,
      };
    },
  };
}

export function createLinearToolFactory(
  dependencies: LinearToolDependencies,
): OpenClawPluginToolFactory {
  return (context) => createLinearTool(dependencies, context);
}
