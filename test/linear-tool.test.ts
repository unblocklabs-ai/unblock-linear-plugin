import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import {
  LINEAR_RUN_BINDING_KEY,
  resolveLinearRunBinding,
  withLinearRunBindingFallback,
  type LinearRunBinding,
} from "../src/linear/run-binding.js";
import {
  LinearToolError,
  createLinearTool,
  createLinearToolFactory,
  linearToolParameters,
  type DurableRpcPort,
  type LinearGraphqlRpcRequest,
  type LinearRpcResult,
  type LinearToolIdentitySource,
} from "../src/linear/tool.js";
import { LINEAR_OPERATION_ACTIONS } from "../src/linear/operations.js";
import type { UploadWorkflow } from "../src/relay/journal.js";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function identitySource(start = 1): LinearToolIdentitySource {
  let next = start;
  return {
    uuid: () => uuid(next++),
    now: () => "2026-08-12T12:00:00.000Z",
  };
}

function rpcResult(
  request: LinearGraphqlRpcRequest,
  payload: LinearRpcResult["payload"],
): LinearRpcResult {
  return {
    v: 1,
    id: uuid(9_000),
    type: "rpc.result",
    agentId: "agent",
    timestamp: "2026-08-12T12:00:01.000Z",
    correlationId: request.correlationId,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    payload,
  };
}

function rpcPort(
  response: (request: LinearGraphqlRpcRequest) => LinearRpcResult,
) {
  const events: string[] = [];
  const port: DurableRpcPort = {
    getRelayIdentity: () => ({ agentId: "agent" }),
    getOrCreateRequest: vi.fn(async (_invocationId, _semanticFingerprint, create) => {
      events.push("persist");
      return create();
    }),
    executePersisted: vi.fn(async (_invocationId, request) => {
      events.push("execute");
      return response(request);
    }),
    consumeResult: vi.fn(async () => { events.push("consume"); }),
  };
  return { port, events };
}

const hostContext = (overrides: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext => ({
  agentId: "default",
  sessionId: "host-session-uuid",
  sessionKey: "agent:default:slack:private-source",
  messageChannel: "slack",
  ...overrides,
});

describe("linear tool", () => {
  it("exports one registration factory with raw and typed action schemas", () => {
    expect(linearToolParameters.oneOf).toHaveLength(10);
    expect(linearToolParameters.oneOf.map((branch) => branch.properties.action.const))
      .toEqual(["graphql", "upload", ...LINEAR_OPERATION_ACTIONS]);

    const { port } = rpcPort((request) => rpcResult(request, { ok: true, result: {} }));
    const factory = createLinearToolFactory({ rpc: port });
    const tool = factory(hostContext());
    expect(tool).toMatchObject({ name: "linear", label: "Linear" });
  });

  it("persists the exact validated request before execution and preserves partial GraphQL results", async () => {
    const envelope = {
      data: { issueUpdate: null },
      errors: [{ message: "Linear field error", path: ["issueUpdate"] }],
      extensions: { trace: "opaque" },
    };
    const { port, events } = rpcPort((request) => rpcResult(request, { ok: true, result: envelope }));
    const tool = createLinearTool({ rpc: port, identity: identitySource() }, hostContext());
    const input = {
      action: "graphql",
      operationName: "UpdateIssue",
      document: "mutation UpdateIssue($id: String!) { issueUpdate(id: $id) { success } }",
      variables: { id: "issue-1", nested: { enabled: true }, nullable: null },
    } as const;

    const result = await tool.execute("tool-call", input);

    expect(events).toEqual(["persist", "execute", "consume"]);
    const request = vi.mocked(port.executePersisted).mock.calls[0][1];
    expect(vi.mocked(port.getOrCreateRequest).mock.calls[0][0])
      .toMatch(/^rpc_[A-Za-z0-9_-]{43}$/u);
    expect(vi.mocked(port.getOrCreateRequest).mock.calls[0][1])
      .toMatch(/^sha256:[A-Za-z0-9_-]{43}$/u);
    expect(vi.mocked(port.executePersisted).mock.calls[0][1]).toBe(request);
    expect(vi.mocked(port.consumeResult).mock.calls[0][0])
      .toBe(vi.mocked(port.getOrCreateRequest).mock.calls[0][0]);
    expect(request).toMatchObject({
      id: uuid(1),
      correlationId: uuid(2),
      idempotencyKey: uuid(3),
      payload: {
        method: "linear.graphql",
        params: {
          operationName: "UpdateIssue",
          document: input.document,
          variables: input.variables,
        },
      },
    });
    expect(request).not.toHaveProperty("sessionId");
    expect(request.payload.params.contextId).toMatch(/^oc_[A-Za-z0-9_-]{43}$/u);
    expect(request.payload.params.contextId).not.toContain("host-session");
    expect(result.details).toEqual(envelope);
    expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""))
      .toEqual(envelope);
  });

  it("compiles typed actions through the same durable executor and validates their result", async () => {
    const response = {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    };
    const { port, events } = rpcPort((request) => rpcResult(request, {
      ok: true,
      result: { data: { issues: response } },
    }));
    const tool = createLinearTool({ rpc: port, identity: identitySource(500) }, hostContext());

    const result = await tool.execute("typed-list", {
      action: "issues.list",
      teamId: "10000000-0000-4000-8000-000000000001",
      first: 5,
    });

    expect(events).toEqual(["persist", "execute", "consume"]);
    expect(vi.mocked(port.executePersisted).mock.calls[0]?.[1].payload.params).toMatchObject({
      operationName: "UnblockLinearIssuesList",
      variables: {
        first: 5,
        includeArchived: false,
        filter: { team: { id: { eq: "10000000-0000-4000-8000-000000000001" } } },
      },
    });
    expect(result.details).toEqual(response);
  });

  it("returns a safe failure for malformed typed results after consuming the durable response", async () => {
    const { port } = rpcPort((request) => rpcResult(request, {
      ok: true,
      result: { data: { issueCreate: { success: true, issue: { id: "incomplete" } } } },
    }));
    const tool = createLinearTool({ rpc: port }, hostContext());

    const result = await tool.execute("typed-create", {
      action: "issues.create",
      teamId: "10000000-0000-4000-8000-000000000001",
      title: "Sensitive malformed response title",
    });
    expect(result.details).toEqual({
      status: "error",
      code: "request_failed",
      message: "The Linear request failed.",
      retryable: false,
      reconciliationRequired: false,
    });
    expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""))
      .toEqual(result.details);
    expect(JSON.stringify(result)).not.toContain("Sensitive malformed response title");
    expect(port.consumeResult).toHaveBeenCalledOnce();
  });

  it("returns a safe failure for invalid typed input without touching durable state", async () => {
    const { port } = rpcPort((request) => rpcResult(request, { ok: true, result: {} }));
    const tool = createLinearTool({ rpc: port }, hostContext());

    const result = await tool.execute("invalid-typed-create", {
      action: "issues.create",
      teamId: "not-a-linear-id",
      title: "Sensitive invalid input title",
      description: "Sensitive invalid input description",
    });

    expect(result.details).toEqual({
      status: "error",
      code: "invalid_input",
      message: "Invalid Linear tool request.",
      retryable: false,
      reconciliationRequired: false,
    });
    expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""))
      .toEqual(result.details);
    expect(JSON.stringify(result)).not.toContain("Sensitive invalid input");
    expect(port.getOrCreateRequest).not.toHaveBeenCalled();
  });

  it.each([
    { code: "unauthorized" as const, retryable: false, expectedRetryable: false },
    { code: "retryable" as const, retryable: true, expectedRetryable: true },
  ])("returns a safe typed failure for $code without exposing inputs or Worker diagnostics", async ({
    code,
    retryable,
    expectedRetryable,
  }) => {
    const { port } = rpcPort((request) => rpcResult(request, {
      ok: false,
      error: { code, message: "secret worker diagnostic", retryable },
    }));
    const tool = createLinearTool({ rpc: port }, hostContext());

    const result = await tool.execute(`typed-${code}`, {
      action: "issues.create",
      teamId: "10000000-0000-4000-8000-000000000001",
      title: "Sensitive remote failure title",
      description: "Sensitive remote failure description",
    });

    expect(result.details).toMatchObject({
      status: "error",
      code,
      retryable: expectedRetryable,
      reconciliationRequired: false,
    });
    expect(result.details).not.toHaveProperty("entityType");
    expect(result.details).not.toHaveProperty("entityId");
    expect(JSON.stringify(result)).not.toContain("Sensitive remote failure");
    expect(JSON.stringify(result)).not.toContain("secret worker diagnostic");
    expect(port.consumeResult).not.toHaveBeenCalled();
  });

  it("preserves abort rejection for typed actions", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const { port } = rpcPort(() => { throw abort; });
    const tool = createLinearTool({ rpc: port }, hostContext());

    await expect(tool.execute("aborted-list", { action: "issues.list" })).rejects.toBe(abort);
  });

  it("exposes only generated reconciliation metadata for an ambiguous typed create", async () => {
    const { port } = rpcPort((request) => rpcResult(request, {
      ok: false,
      error: { code: "outcome_unknown", message: "secret worker diagnostic", retryable: false },
    }));
    const tool = createLinearTool({ rpc: port, identity: identitySource(600) }, hostContext());

    const result = await tool.execute("typed-create", {
      action: "issues.create",
      teamId: "10000000-0000-4000-8000-000000000001",
      title: "Secret customer title",
      description: "Secret customer description",
    });

    expect(result.details).toMatchObject({
      status: "error",
      code: "outcome_unknown",
      reconciliationRequired: true,
      entityType: "issue",
      entityId: uuid(600),
    });
    expect(result.details).toMatchObject({
      message: `The Linear issue creation outcome is unknown. Query the issue with ID ${uuid(600)} before retrying; do not create it again until reconciled.`,
    });
    expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""))
      .toEqual(result.details);
    expect(JSON.stringify(result)).not.toContain("secret worker diagnostic");
    expect(JSON.stringify(result)).not.toContain("Secret customer");
    expect(vi.mocked(port.executePersisted).mock.calls[0]?.[1].payload.params.variables)
      .toMatchObject({ input: { id: uuid(600) } });
    expect(port.executePersisted).toHaveBeenCalledOnce();
    expect(port.consumeResult).not.toHaveBeenCalled();
  });

  it("keeps a persisted create ID authoritative when the same tool call is re-entered", async () => {
    let persisted: LinearGraphqlRpcRequest | undefined;
    const fingerprints: string[] = [];
    const port: DurableRpcPort = {
      getRelayIdentity: () => ({ agentId: "agent" }),
      getOrCreateRequest: vi.fn(async (_invocationId, fingerprint, create) => {
        fingerprints.push(fingerprint);
        const request = persisted ?? create();
        persisted = request;
        return request;
      }),
      executePersisted: vi.fn(async (_invocationId, request) => rpcResult(request, {
        ok: false,
        error: { code: "outcome_unknown", message: "ambiguous", retryable: false },
      })),
      consumeResult: vi.fn(async () => { persisted = undefined; }),
    };
    const tool = createLinearTool({ rpc: port, identity: identitySource(700) }, hostContext());
    const input = {
      action: "issues.create",
      teamId: "10000000-0000-4000-8000-000000000001",
      title: "One durable create",
    } as const;

    const first = await tool.execute("same-tool-call", input);
    expect(first.details).toMatchObject({ entityId: uuid(700) });
    const second = await tool.execute("same-tool-call", input);
    expect(second.details).toMatchObject({ entityId: uuid(700) });

    expect(fingerprints[0]).toBe(fingerprints[1]);
    expect(vi.mocked(port.executePersisted).mock.calls[0]?.[1])
      .toBe(vi.mocked(port.executePersisted).mock.calls[1]?.[1]);
    expect(persisted?.payload.params.variables).toMatchObject({ input: { id: uuid(700) } });
    expect(port.consumeResult).not.toHaveBeenCalled();
  });

  it("derives a stable opaque context and adds sessionId only through the Linear run binding", async () => {
    const requests: LinearGraphqlRpcRequest[] = [];
    const { port } = rpcPort((request) => {
      requests.push(request);
      return rpcResult(request, { ok: true, result: { data: { viewer: { id: "me" } } } });
    });
    const context = hostContext({
      messageChannel: "unblock-linear",
      toolBindings: {
        [LINEAR_RUN_BINDING_KEY]: {
          linearSessionId: "linear-session",
          contextId: "persisted-linear-context",
          deliveryId: "delivery-1",
          teamId: "team-1",
        },
      },
    });
    const tool = createLinearTool({ rpc: port, identity: identitySource(20) }, context);

    await tool.execute("first", { action: "graphql", document: "query { viewer { id } }" });
    await tool.execute("second", { action: "graphql", document: "query { viewer { id } }" });

    expect(requests.map((request) => request.sessionId)).toEqual(["linear-session", "linear-session"]);
    expect(requests.map((request) => request.payload.params.contextId))
      .toEqual(["persisted-linear-context", "persisted-linear-context"]);
    expect(vi.mocked(port.getOrCreateRequest).mock.calls.map((call) => call[3]))
      .toEqual(["delivery-1", "delivery-1"]);
  });

  it("uses the active delivery fallback only for the exact OpenClaw identity", async () => {
    const requests: LinearGraphqlRpcRequest[] = [];
    const { port } = rpcPort((request) => {
      requests.push(request);
      return rpcResult(request, { ok: true, result: {} });
    });
    const binding: LinearRunBinding = {
      linearSessionId: "linear-session",
      contextId: "persisted-linear-context",
      deliveryId: "delivery-fallback",
      teamId: "team-1",
    };
    const matchingContext = hostContext({
      agentId: "selected-agent",
      sessionId: "persisted-openclaw-session",
      sessionKey: "agent:selected-agent:unblock-linear:linear-session",
      toolBindings: undefined,
    });
    const otherContext = { ...matchingContext, sessionId: "other-openclaw-session" };
    const matching = createLinearTool({ rpc: port, identity: identitySource(300) }, matchingContext);
    const other = createLinearTool({ rpc: port, identity: identitySource(400) }, otherContext);

    await withLinearRunBindingFallback(matchingContext, binding, async () => {
      await matching.execute("matching", { action: "graphql", document: "query { viewer { id } }" });
      await other.execute("other", { action: "graphql", document: "query { viewer { id } }" });
    });

    expect(requests[0]).toMatchObject({
      sessionId: "linear-session",
      payload: { params: { contextId: "persisted-linear-context" } },
    });
    expect(requests[1]).not.toHaveProperty("sessionId");
    expect(requests[1]?.payload.params.contextId).not.toBe("persisted-linear-context");
  });

  it("refuses a host/fallback conflict and clears fallback state on success and error", async () => {
    const { port } = rpcPort((request) => rpcResult(request, { ok: true, result: {} }));
    const identity = {
      agentId: "selected-agent",
      sessionId: "persisted-openclaw-session",
      sessionKey: "agent:selected-agent:unblock-linear:linear-session",
    };
    const fallback: LinearRunBinding = {
      linearSessionId: "linear-session",
      contextId: "persisted-linear-context",
      deliveryId: "delivery-fallback",
      teamId: "team-1",
    };
    const conflicting = createLinearTool({ rpc: port }, {
      ...identity,
      toolBindings: {
        [LINEAR_RUN_BINDING_KEY]: { ...fallback, deliveryId: "other-delivery" },
      },
    });

    await withLinearRunBindingFallback(identity, fallback, async () => {
      await expect(conflicting.execute("conflict", {
        action: "graphql",
        document: "query { viewer { id } }",
      })).rejects.toMatchObject({ code: "state_unavailable" });
    });
    expect(resolveLinearRunBinding(identity)).toBeUndefined();
    expect(port.getOrCreateRequest).not.toHaveBeenCalled();

    await expect(withLinearRunBindingFallback(identity, fallback, async () => {
      throw new Error("run failed");
    })).rejects.toThrow("run failed");
    expect(resolveLinearRunBinding(identity)).toBeUndefined();
  });

  it("isolates the same host tool-call id across owning contexts", async () => {
    const { port } = rpcPort((request) => rpcResult(request, { ok: true, result: {} }));
    const first = createLinearTool({ rpc: port, identity: identitySource(100) }, hostContext({
      sessionId: "host-session-one",
    }));
    const second = createLinearTool({ rpc: port, identity: identitySource(200) }, hostContext({
      sessionId: "host-session-two",
    }));

    await first.execute("shared-tool-call", { action: "graphql", document: "query { viewer { id } }" });
    await second.execute("shared-tool-call", { action: "graphql", document: "query { viewer { id } }" });

    const calls = vi.mocked(port.getOrCreateRequest).mock.calls;
    expect(calls[0]?.[0]).not.toBe(calls[1]?.[0]);
    expect(calls[0]?.[1]).not.toBe(calls[1]?.[1]);
  });

  it("fails closed on malformed run binding instead of inheriting session authority", async () => {
    const { port } = rpcPort((request) => rpcResult(request, { ok: true, result: {} }));
    const tool = createLinearTool({ rpc: port }, hostContext({
      toolBindings: { [LINEAR_RUN_BINDING_KEY]: { sessionId: "untrusted-shape" } },
    }));

    await expect(tool.execute("call", { action: "graphql", document: "query { viewer { id } }" }))
      .rejects.toMatchObject({ code: "state_unavailable" });
    expect(port.getOrCreateRequest).not.toHaveBeenCalled();
  });

  it("validates through the bounded protocol shape before touching durable state", async () => {
    const { port } = rpcPort((request) => rpcResult(request, { ok: true, result: {} }));
    const tool = createLinearTool({ rpc: port }, hostContext());

    await expect(tool.execute("call", {
      action: "graphql",
      document: "query { viewer { id } }",
      variables: ["not", "an", "object"],
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(tool.execute("call", {
      action: "graphql",
      document: "x".repeat(48_001),
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(tool.execute("call", {
      action: "graphql",
      document: "query { viewer { id } }",
      contextId: "model-supplied-private-identity",
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(port.getOrCreateRequest).not.toHaveBeenCalled();
  });

  it("keeps upload inert and refuses arbitrary file paths and URLs", async () => {
    const { port } = rpcPort((request) => rpcResult(request, { ok: true, result: {} }));
    const tool = createLinearTool({ rpc: port }, hostContext());

    await expect(tool.execute("call", { action: "upload", fileRef: "media://inbound/opaque_1" }))
      .rejects.toMatchObject({ code: "not_available", message: "Linear managed file upload is not available yet." });
    await expect(tool.execute("call", { action: "upload", fileRef: "/private/file.txt" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(tool.execute("call", { action: "upload", fileRef: "https://example.com/file" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(port.getOrCreateRequest).not.toHaveBeenCalled();
    expect(port.executePersisted).not.toHaveBeenCalled();
  });

  it("routes managed upload destination requests through the same durable GraphQL port", async () => {
    const { port } = rpcPort((request) => rpcResult(request, {
      ok: true,
      result: {
        data: {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://uploads.linear.app/signed",
              assetUrl: "https://uploads.linear.app/asset",
              headers: [{ key: "Content-Type", value: "text/plain" }],
            },
          },
        },
      },
    }));
    let workflow: UploadWorkflow | undefined;
    const tool = createLinearTool({
      rpc: port,
      identity: identitySource(70),
      upload: {
        media: {
          resolve: async () => ({
            size: 1,
            filename: "note.txt",
            contentType: "text/plain",
            stream: async () => new ReadableStream({
              start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); },
            }),
          }),
        },
        fetch: { put: async () => ({ status: 200 }) },
        workflows: {
          getUpload: () => workflow,
          recordUpload: async (value) => { workflow = value; return value; },
          updateUpload: async (uploadId, patch) => {
            if (workflow === undefined) throw new Error("missing workflow");
            workflow = { ...workflow, ...patch, uploadId };
            return workflow;
          },
        },
      },
    }, hostContext({
      toolBindings: {
        [LINEAR_RUN_BINDING_KEY]: {
          linearSessionId: "linear-session",
          contextId: "host-session-uuid",
          deliveryId: "delivery-1",
          teamId: "linear-team",
        },
      },
    }));

    await expect(tool.execute("upload-tool-call", {
      action: "upload",
      fileRef: "media://inbound/opaque",
    })).resolves.toMatchObject({ details: { assetUrl: "https://uploads.linear.app/asset" } });
    expect(vi.mocked(port.getOrCreateRequest).mock.calls[0][0])
      .toMatch(/^rpc_[A-Za-z0-9_-]{43}$/u);
    const request = vi.mocked(port.executePersisted).mock.calls[0][1];
    expect(request.payload).toMatchObject({
      method: "linear.graphql",
      params: {
        operationName: "UnblockLinearFileUpload",
        variables: { contentType: "text/plain", filename: "note.txt", size: 1 },
      },
    });
    expect(request.payload.params.document).toContain("fileUpload");
    expect(workflow).toMatchObject({
      ownerId: "host-session-uuid",
      deliveryId: "delivery-1",
      sessionId: "linear-session",
      status: "completed",
    });
  });

  it.each([
    {
      workerCode: "invalid_request" as const,
      retryable: false,
      expectedCode: "invalid_request",
      expectedText: "Linear rejected the GraphQL request as invalid.",
      consumed: true,
    },
    {
      workerCode: "unauthorized" as const,
      retryable: false,
      expectedCode: "unauthorized",
      expectedText: "This Linear request is no longer authorized.",
      consumed: false,
    },
    {
      workerCode: "retryable" as const,
      retryable: true,
      expectedCode: "retryable",
      expectedText: "Linear is temporarily unavailable. Retry the same durable request.",
      consumed: false,
    },
    {
      workerCode: "outcome_unknown" as const,
      retryable: false,
      expectedCode: "outcome_unknown",
      expectedText: "The Linear mutation outcome is unknown. Reconcile it with a read query before trying another mutation.",
      consumed: false,
    },
  ])("raw GraphQL rejects $workerCode without exposing Worker content", async ({
    workerCode,
    retryable,
    expectedCode,
    expectedText,
    consumed,
  }) => {
    const { port } = rpcPort((request) => rpcResult(request, {
      ok: false,
      error: { code: workerCode, message: "secret worker diagnostic", retryable },
    }));
    const tool = createLinearTool({ rpc: port, identity: identitySource(40) }, hostContext());

    const invocation = tool.execute("call", {
      action: "graphql",
      document: "mutation { issueArchive(id: \"issue-1\") { success } }",
    });
    await expect(invocation).rejects.toMatchObject({ code: expectedCode, message: expectedText });
    await expect(invocation).rejects.not.toThrow("secret worker diagnostic");
    expect(port.consumeResult).toHaveBeenCalledTimes(consumed ? 1 : 0);
    if (workerCode === "retryable") {
      expect(vi.mocked(port.executePersisted).mock.calls[0][1]).toBeDefined();
    }
    if (workerCode === "outcome_unknown") {
      await expect(invocation).rejects.toMatchObject({ reconciliationRequired: true });
    }
  });

  it("rejects an uncorrelated result without consuming or exposing it", async () => {
    const { port } = rpcPort((request) => ({
      ...rpcResult(request, { ok: false, error: { code: "internal", message: "secret", retryable: false } }),
      correlationId: uuid(9_999),
    }));
    const tool = createLinearTool({ rpc: port, identity: identitySource(60) }, hostContext());

    await expect(tool.execute("call", { action: "graphql", document: "query { viewer { id } }" }))
      .rejects.toMatchObject({ code: "state_unavailable" });
    expect(port.consumeResult).not.toHaveBeenCalled();
  });

  it("uses content-free typed errors", () => {
    const error = new LinearToolError("request_failed", "The Linear request failed.");
    expect(error).toMatchObject({ name: "LinearToolError", retryable: false, reconciliationRequired: false });
  });
});
