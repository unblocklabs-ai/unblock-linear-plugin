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
    deviceId: "device",
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
    getRelayIdentity: () => ({ agentId: "agent", deviceId: "device" }),
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
  it("exports one registration factory with the graphql/upload discriminated schema", () => {
    expect(linearToolParameters.oneOf).toHaveLength(2);
    expect(linearToolParameters.oneOf.map((branch) => branch.properties.action.const))
      .toEqual(["graphql", "upload"]);

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
    }, hostContext());

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
      expectedText: "Linear authorization is unavailable. Reauthorize and reconnect the plugin.",
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
      consumed: true,
    },
  ])("maps $workerCode without exposing Worker content", async ({
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
