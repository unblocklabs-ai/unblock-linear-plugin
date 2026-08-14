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
  LINEAR_OPERATION_ACTIONS,
  LinearOperationNotFoundError,
  compileLinearOperation,
  linearOperationInputSchemas,
  type LinearMutationReconciliation,
  type LinearOperationInput,
} from "./operations.js";
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
    }
  | LinearOperationInput;

type RpcRequestFrame = Extract<OutboundRelayFrame, { type: "rpc.request" }>;
export type LinearGraphqlRpcRequest = Omit<RpcRequestFrame, "payload"> & {
  payload: Extract<RpcRequestFrame["payload"], { method: "linear.graphql" }>;
};
export type LinearRpcResult = Extract<InboundRelayFrame, { type: "rpc.result" }>;

export type RelayIdentity = {
  agentId: string;
};

/**
 * The relay service implements this small durability boundary. It must retain
 * the exact persisted request until consumeResult succeeds. Reconnect and any
 * retryable resend use the same complete request, including its relay identity.
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
  | "not_found"
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
    readonly reconciliation?: LinearMutationReconciliation,
  ) {
    super(message);
    this.name = "LinearToolError";
  }
}

const typedLinearActions = new Set<string>(LINEAR_OPERATION_ACTIONS);

function compactJsonResult<T>(details: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function isTypedLinearAction(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const action = Reflect.get(value, "action");
  return typeof action === "string" && typedLinearActions.has(action);
}

function isAbortFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function safeTypedFailure(error: unknown) {
  const typedError = error instanceof LinearToolError ? error : undefined;
  const code: LinearToolErrorCode = typedError?.code ?? "request_failed";
  const reconciliation = typedError?.reconciliation;
  const message = (() => {
    switch (code) {
      case "invalid_input": return "Invalid Linear tool request.";
      case "not_available": return "Linear is not available for this request.";
      case "state_unavailable": return "Linear is unavailable for this run. Check the plugin connection state.";
      case "invalid_request": return "Linear rejected the request as invalid.";
      case "not_found": return "Linear issue was not found or is not accessible.";
      case "unauthorized": return "This Linear request is no longer authorized.";
      case "retryable": return "Linear is temporarily unavailable. Retry the same durable request.";
      case "outcome_unknown":
        return reconciliation === undefined
          ? "The Linear mutation outcome is unknown. Reconcile it with a read query before trying another mutation."
          : `The Linear ${reconciliation.entityType} creation outcome is unknown. Query the ${reconciliation.entityType} with ID ${reconciliation.entityId} before retrying; do not create it again until reconciled.`;
      case "request_failed": return "The Linear request failed.";
    }
  })();
  return {
    status: "error" as const,
    code,
    message,
    retryable: typedError?.retryable ?? false,
    reconciliationRequired: typedError?.reconciliationRequired ?? false,
    ...(reconciliation === undefined ? {} : {
      entityType: reconciliation.entityType,
      entityId: reconciliation.entityId,
    }),
  };
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

const linearToolInputSchema = z.union([
  graphqlInputSchema,
  uploadInputSchema,
  ...linearOperationInputSchemas,
]);

const pageProperties = {
  first: { type: "integer", minimum: 1, maximum: 50 },
  after: { type: "string", minLength: 1, maxLength: 1_024 },
} as const;
const entityIdProperty = { type: "string", format: "uuid" } as const;
const issueProjectionDescription = "Returns a fixed issue projection and cursor pageInfo. Pass Linear IDs, not names.";

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
    {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      description: issueProjectionDescription,
      properties: {
        action: { const: LINEAR_OPERATION_ACTIONS[0] },
        ...pageProperties,
        teamId: entityIdProperty,
        stateId: entityIdProperty,
        assigneeId: entityIdProperty,
        includeArchived: { type: "boolean" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "query"],
      description: `${issueProjectionDescription} Search is separately limited to 20 results per request.`,
      properties: {
        action: { const: LINEAR_OPERATION_ACTIONS[1] },
        query: { type: "string", minLength: 1, maxLength: 256 },
        first: { type: "integer", minimum: 1, maximum: 20 },
        after: pageProperties.after,
        teamId: entityIdProperty,
        includeArchived: { type: "boolean" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "id"],
      properties: {
        action: { const: LINEAR_OPERATION_ACTIONS[2] },
        id: { type: "string", minLength: 1, maxLength: 128, description: "Linear issue UUID or identifier, for example ENG-123." },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "teamId", "title"],
      properties: {
        action: { const: LINEAR_OPERATION_ACTIONS[3] },
        teamId: entityIdProperty,
        title: { type: "string", minLength: 1, maxLength: 512 },
        description: { type: "string", maxLength: 32_000 },
        stateId: entityIdProperty,
        assigneeId: entityIdProperty,
        priority: { type: "integer", minimum: 0, maximum: 4 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "id"],
      anyOf: ["title", "description", "stateId", "assigneeId", "priority"].map((field) => ({ required: [field] })),
      properties: {
        action: { const: LINEAR_OPERATION_ACTIONS[4] },
        id: { type: "string", minLength: 1, maxLength: 128 },
        title: { type: "string", minLength: 1, maxLength: 512 },
        description: { type: ["string", "null"], maxLength: 32_000 },
        stateId: entityIdProperty,
        assigneeId: { type: ["string", "null"], format: "uuid" },
        priority: { type: "integer", minimum: 0, maximum: 4 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "issueId", "body"],
      properties: {
        action: { const: LINEAR_OPERATION_ACTIONS[5] },
        issueId: { type: "string", minLength: 1, maxLength: 128 },
        body: { type: "string", minLength: 1, maxLength: 32_000 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { const: LINEAR_OPERATION_ACTIONS[6] },
        ...pageProperties,
        includeArchived: { type: "boolean" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "teamId"],
      properties: {
        action: { const: LINEAR_OPERATION_ACTIONS[7] },
        teamId: entityIdProperty,
        ...pageProperties,
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
  reconciliation?: LinearMutationReconciliation,
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
    variables: semanticVariables(input.variables ?? {}, reconciliation),
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

function semanticVariables(
  variables: Record<string, JsonValue>,
  reconciliation: LinearMutationReconciliation | undefined,
): Record<string, JsonValue> {
  if (reconciliation === undefined) return variables;
  const mutationInput = variables.input;
  if (mutationInput === null || typeof mutationInput !== "object" || Array.isArray(mutationInput)) {
    return variables;
  }
  return { ...variables, input: { ...mutationInput, id: null } };
}

function persistedReconciliation(
  request: LinearGraphqlRpcRequest,
  template: LinearMutationReconciliation | undefined,
): LinearMutationReconciliation | undefined {
  if (template === undefined) return undefined;
  const mutationInput = request.payload.params.variables.input;
  if (mutationInput === null || typeof mutationInput !== "object" || Array.isArray(mutationInput)) {
    return undefined;
  }
  const id = mutationInput.id;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) return undefined;
  return { ...template, entityId: parsedId.data };
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

function mapRpcFailure(
  error: Extract<LinearRpcResult["payload"], { ok: false }>["error"],
  reconciliation?: LinearMutationReconciliation,
): never {
  if (error.code === "invalid_request") {
    throw new LinearToolError("invalid_request", "Linear rejected the GraphQL request as invalid.");
  }
  if (error.code === "unauthorized") {
    throw new LinearToolError(
      "unauthorized",
      "This Linear request is no longer authorized.",
    );
  }
  if (error.code === "outcome_unknown") {
    const message = reconciliation === undefined
      ? "The Linear mutation outcome is unknown. Reconcile it with a read query before trying another mutation."
      : `The Linear ${reconciliation.entityType} creation outcome is unknown. Query the ${reconciliation.entityType} with ID ${reconciliation.entityId} before retrying; do not create it again until reconciled.`;
    throw new LinearToolError(
      "outcome_unknown",
      message,
      false,
      true,
      reconciliation,
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
    reconciliation?: LinearMutationReconciliation,
  ): Promise<unknown> => {
    const { invocationId, semanticFingerprint } = durableRpcIdentity(
      toolCallId,
      action,
      input,
      context,
      runBinding,
      reconciliation,
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
    const reconciliationMetadata = persistedReconciliation(request, reconciliation);

    // An ambiguous mutation must remain durably recorded. Consuming it would let
    // the same host tool call create a fresh request and entity ID on re-entry.
    if (!result.payload.ok && (
      result.payload.error.retryable ||
      result.payload.error.code === "unauthorized" ||
      result.payload.error.code === "outcome_unknown"
    )) {
      mapRpcFailure(result.payload.error, reconciliationMetadata);
    }
    await dependencies.rpc.consumeResult(invocationId, result);
    if (!result.payload.ok) mapRpcFailure(result.payload.error, reconciliationMetadata);
    return result.payload.result;
  };

  const executeToolCall = async (
    toolCallId: string,
    value: unknown,
    signal?: AbortSignal,
  ) => {
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
        toolCallId,
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
      return compactJsonResult(uploaded);
    }

    if (input.action !== "graphql") {
      const operation = compileLinearOperation(input, identity.uuid);
      const graphqlResult = await executeGraphql(
        toolCallId,
        operation.action,
        operation.graphql,
        runBinding,
        signal,
        operation.reconciliation,
      );
      let typedResult: unknown;
      try {
        typedResult = operation.parseResult(graphqlResult);
      } catch (error) {
        if (error instanceof LinearOperationNotFoundError) {
          throw new LinearToolError("not_found", "Linear issue was not found or is not accessible.");
        }
        throw error;
      }
      return compactJsonResult(typedResult);
    }

    const graphqlResult = await executeGraphql(toolCallId, input.action, input, runBinding, signal);

    return compactJsonResult(graphqlResult);
  };

  return {
    name: "linear",
    label: "Linear",
    description: "List, search, create, or update Linear issues with GraphQL, or upload OpenClaw-managed media through the connected installation.",
    parameters: linearToolParameters,
    async execute(toolCallId, value, signal) {
      const typedAction = isTypedLinearAction(value);
      try {
        return await executeToolCall(toolCallId, value, signal);
      } catch (error) {
        if (!typedAction || isAbortFailure(error, signal)) throw error;
        const failure = safeTypedFailure(error);
        return compactJsonResult(failure);
      }
    },
  };
}

export function createLinearToolFactory(
  dependencies: LinearToolDependencies,
): OpenClawPluginToolFactory {
  return (context) => createLinearTool(dependencies, context);
}
