import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it, vi } from "vitest";
import entry from "../index.js";
import type { DeliveryRuntimePort } from "../src/delivery/executor.js";
import type { LinearGraphqlRpcRequest } from "../src/linear/tool.js";
import {
  createIntegrationRegistration,
  type IntegrationRegistration,
} from "../src/integration.js";
import { parseOutboundRelayFrame, type OutboundRelayFrame } from "../src/relay/protocol.js";
import { RelayJournal } from "../src/relay/journal.js";
import type { RelaySocket, RelaySocketFactory } from "../src/relay/service.js";

const PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "z8ji77cSxUiWOdGk8KCSV0p1jLBJl4zgEDOj6R4DtMA",
  y: "ONa1i6bQCT76I1gwX_nxsJQnQss31Pkf8AAUP3RqAA0",
  d: "-Cn-hKIQXIuHi07HA0WnkgcZD_G5-1hOeR-ETgpKZDU",
} as const;

const config: OpenClawConfig = {
  channels: {
    "unblock-linear": {
      enabled: true,
      accountId: "default",
      origin: "https://linear-staging.unblocklabs.ai",
      agentId: "relay-agent",
      deviceId: "relay-device",
      enrollmentGeneration: 1,
      devicePrivateKey: { source: "env", provider: "default", id: "LINEAR_DEVICE_KEY" },
    },
  },
  agents: {
    list: [{ id: "selected-agent", workspace: "/tmp/selected-workspace" }],
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

class FakeSocket implements RelaySocket {
  readonly sent: string[] = [];
  readonly sentAtClose: string[][] = [];
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: string | ArrayBuffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number, reason: string | Buffer) => void): unknown;
  on(
    event: "unexpected-response",
    listener: (response: { statusCode: number; body?: string }) => Promise<void> | void,
  ): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return undefined;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.sentAtClose.push([...this.sent]);
    this.emit("close", code, reason);
  }

  open(): void {
    this.emit("open");
  }

  message(frame: unknown): void {
    this.emit("message", JSON.stringify(frame));
  }

  unexpectedResponse(statusCode: number, body?: string): void {
    this.emit("unexpected-response", { statusCode, ...(body === undefined ? {} : { body }) });
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      Reflect.apply(listener, undefined, args);
    }
  }
}

function runtimeFixture(runEmbeddedAgent: DeliveryRuntimePort["agent"]["runEmbeddedAgent"] = async () => ({
  payloads: [{ text: "Done" }],
  meta: { durationMs: 1 },
})): DeliveryRuntimePort {
  type SessionEntry = NonNullable<
    ReturnType<DeliveryRuntimePort["agent"]["session"]["getSessionEntry"]>
  >;
  const sessionEntries = new Map<string, SessionEntry>();
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(() => route),
      },
      inbound: {
        buildContext: vi.fn(() => ({
          CommandAuthorized: false,
        })) as unknown as DeliveryRuntimePort["channel"]["inbound"]["buildContext"],
      },
      session: {
        recordInboundSession: vi.fn(async (input) => {
          sessionEntries.set(input.sessionKey, sessionEntries.get(input.sessionKey) ?? {
            sessionId: "persisted-selected-session",
            updatedAt: 0,
          });
        }),
      },
    },
    agent: {
      runEmbeddedAgent: vi.fn(runEmbeddedAgent),
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
}

function apiWithRuntime(runtime: DeliveryRuntimePort): OpenClawPluginApi {
  return {
    runtime,
  } as unknown as OpenClawPluginApi;
}

function serviceContext(stateDir: string): Parameters<IntegrationRegistration["service"]["start"]>[0] {
  return {
    config,
    stateDir,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

function requireTool(registration: IntegrationRegistration) {
  const context: Parameters<IntegrationRegistration["toolFactory"]>[0] = {
    sessionId: "openclaw-session",
    sessionKey: route.sessionKey,
    agentId: route.agentId,
  };
  const candidate = registration.toolFactory(context);
  if (candidate === null || candidate === undefined || Array.isArray(candidate)) {
    throw new Error("Expected one Linear tool");
  }
  return candidate;
}

function sentFrames(socket: FakeSocket): OutboundRelayFrame[] {
  return socket.sent.map((value) => parseOutboundRelayFrame(value));
}

async function waitFor(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assertion();
}

function inboundBase() {
  return {
    v: 1 as const,
    agentId: "relay-agent",
    deviceId: "relay-device",
    timestamp: "2026-08-12T12:00:00.000Z",
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

describe("OpenClaw integration", () => {
  it("registers one service and one tool factory only in full runtime mode", () => {
    const registerChannel = vi.fn();
    const registerService = vi.fn();
    const registerTool = vi.fn();
    const registerGatewayMethod = vi.fn();
    const registerCli = vi.fn();

    entry.register({
      registrationMode: "full",
      runtime: runtimeFixture(),
      registerChannel,
      registerService,
      registerTool,
      registerGatewayMethod,
      registerCli,
    } as unknown as OpenClawPluginApi);

    expect(registerChannel).toHaveBeenCalledOnce();
    expect(registerService).toHaveBeenCalledOnce();
    expect(registerTool).toHaveBeenCalledOnce();
    expect(registerGatewayMethod).toHaveBeenCalledOnce();
    expect(registerCli).toHaveBeenCalledOnce();
    expect(typeof registerTool.mock.calls[0]?.[0]).toBe("function");
  });

  it("resolves the SecretRef, wires durable RPC results, and fails closed outside service lifetime", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "unblock-linear-integration-"));
    const socket = new FakeSocket();
    const socketFactory: RelaySocketFactory = vi.fn(() => socket);
    const resolveSecret = vi.fn(async () => JSON.stringify(PRIVATE_JWK));
    const env = { LINEAR_DEVICE_KEY: "not-read-directly" };
    const registration = createIntegrationRegistration(apiWithRuntime(runtimeFixture()), {
      env,
      resolveSecret,
      socketFactory,
    });
    const tool = requireTool(registration);

    await expect(tool.execute("before-start", {
      action: "graphql",
      document: "query { viewer { id } }",
    })).rejects.toThrow("Linear relay is unavailable");

    await registration.service.start(serviceContext(stateDir));
    socket.open();
    await waitFor(() => expect(registration.getState()).toMatchObject({
      accountId: "default",
      running: true,
      connected: true,
      statusState: "connected",
    }));

    expect(resolveSecret).toHaveBeenCalledWith({
      config,
      env,
      value: config.channels?.["unblock-linear"]?.devicePrivateKey,
      path: "channels.unblock-linear.devicePrivateKey",
    });
    expect(socketFactory).toHaveBeenCalledOnce();
    await expect(access(join(stateDir, "plugins", "unblock-linear", "relay-journal.json")))
      .resolves.toBeUndefined();

    const invocation = tool.execute("rpc-call", {
      action: "graphql",
      document: "query { viewer { id } }",
    });
    let request: Extract<OutboundRelayFrame, { type: "rpc.request" }> | undefined;
    await waitFor(() => {
      request = sentFrames(socket).find((frame) => frame.type === "rpc.request");
      expect(request).toBeDefined();
    });
    socket.message({
      ...inboundBase(),
      id: uuid(51),
      type: "rpc.result",
      correlationId: request?.correlationId,
      payload: { ok: true, result: { data: { viewer: { id: "viewer-1" } } } },
    });

    await expect(invocation).resolves.toMatchObject({
      details: { data: { viewer: { id: "viewer-1" } } },
    });
    await registration.service.stop?.(serviceContext(stateDir));
    expect(registration.getState()).toMatchObject({
      accountId: "default",
      running: false,
      connected: false,
      statusState: "stopped",
    });
    await expect(tool.execute("after-stop", {
      action: "graphql",
      document: "query { viewer { id } }",
    })).rejects.toThrow("Linear relay is unavailable");
    await expect(registration.reconnect()).rejects.toThrow("The Unblock Linear service is unavailable");
  });

  it("persists an exact stale-generation upgrade response and fences reconnect", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "unblock-linear-stale-generation-"));
    const socket = new FakeSocket();
    const registration = createIntegrationRegistration(apiWithRuntime(runtimeFixture()), {
      resolveSecret: async () => JSON.stringify(PRIVATE_JWK),
      socketFactory: () => socket,
    });

    await registration.service.start(serviceContext(stateDir));
    socket.unexpectedResponse(409, '{"error":"device_replaced"}');
    await waitFor(() => expect(registration.getState().statusState).toBe("device_replaced"));
    socket.close(1006, "upgrade rejected");
    await vi.waitFor(async () => {
      await expect(access(join(stateDir, "plugins", "unblock-linear", "relay-writer.lock")))
        .rejects.toThrow();
    });

    const journal = await RelayJournal.open(
      join(stateDir, "plugins", "unblock-linear", "relay-journal.json"),
    );
    expect(journal.getLifecycle()).toEqual({ fence: "device_replaced", generation: 1 });
    await expect(registration.reconnect())
      .rejects.toThrow("Update the Unblock Linear enrollment configuration");
    await registration.service.stop?.(serviceContext(stateDir));
  });

  it("cleans up a false relay start behind a device-replaced fence", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "unblock-linear-replaced-"));
    const pluginStateDir = join(stateDir, "plugins", "unblock-linear");
    await mkdir(pluginStateDir, { recursive: true });
    const journal = await RelayJournal.open(join(pluginStateDir, "relay-journal.json"));
    await journal.setLifecycle("device_replaced", 2);
    const socketFactory = vi.fn(() => new FakeSocket());
    const registration = createIntegrationRegistration(apiWithRuntime(runtimeFixture()), {
      resolveSecret: async () => JSON.stringify(PRIVATE_JWK),
      socketFactory,
    });

    await registration.service.start(serviceContext(stateDir));

    expect(socketFactory).not.toHaveBeenCalled();
    expect(registration.getState()).toMatchObject({
      accountId: "default",
      running: false,
      connected: false,
      statusState: "device_replaced",
    });
    await expect(access(join(pluginStateDir, "relay-writer.lock"))).rejects.toThrow();
    await expect(requireTool(registration).execute("replaced", {
      action: "graphql",
      document: "query { viewer { id } }",
    })).rejects.toThrow("Linear relay is unavailable");
    await expect(registration.reconnect()).rejects.toThrow("Update the Unblock Linear enrollment configuration");
  });

  it("resolves guarded managed media and streams an exact redirect-blocked upload", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "unblock-linear-managed-upload-"));
    const mediaPath = join(stateDir, "managed-note.txt");
    const mediaBytes = new TextEncoder().encode("managed upload body");
    await writeFile(mediaPath, mediaBytes);
    const socket = new FakeSocket();
    const resolveMediaPath = vi.fn(async () => mediaPath);
    const uploadFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(_url).toBe("https://uploads.linear.app/signed?opaque=1");
      expect(init).toBeDefined();
      expect(Object.keys(init ?? {}).sort()).toEqual([
        "body",
        "duplex",
        "headers",
        "method",
        "redirect",
        "signal",
      ]);
      expect(init).toMatchObject({
        method: "PUT",
        redirect: "error",
        duplex: "half",
        headers: {
          "Content-Type": "text/plain",
          "x-linear-upload": "opaque",
          "Content-Length": String(mediaBytes.byteLength),
        },
      });
      expect(Object.keys(init?.headers ?? {})).toEqual(["Content-Type", "x-linear-upload", "Content-Length"]);
      if (!(init?.body instanceof ReadableStream)) throw new Error("Expected a web stream body");
      const received: number[] = [];
      const reader = init.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received.push(...chunk.value);
      }
      expect(received).toEqual([...mediaBytes]);
      return new Response(null, { status: 201 });
    });
    const registration = createIntegrationRegistration(apiWithRuntime(runtimeFixture()), {
      resolveSecret: async () => JSON.stringify(PRIVATE_JWK),
      socketFactory: () => socket,
      resolveMediaPath,
      uploadFetch,
    });
    const tool = requireTool(registration);
    const uploadInput = {
      action: "upload",
      fileRef: "media://inbound/managed-note---05197874-4019-4dcf-bc13-686af0978997.txt",
    } as const;

    await expect(tool.execute("before-upload-start", uploadInput))
      .rejects.toMatchObject({ code: "not_available" });
    await registration.service.start(serviceContext(stateDir));
    socket.open();
    const controller = new AbortController();
    const upload = tool.execute("managed-upload", uploadInput, controller.signal);
    let request: LinearGraphqlRpcRequest | undefined;
    await waitFor(() => {
      request = sentFrames(socket).find((frame): frame is LinearGraphqlRpcRequest =>
        frame.type === "rpc.request" && frame.payload.method === "linear.graphql" &&
        frame.payload.params.operationName === "UnblockLinearFileUpload");
      expect(request).toBeDefined();
    });

    expect(resolveMediaPath).toHaveBeenCalledWith(
      "managed-note---05197874-4019-4dcf-bc13-686af0978997.txt",
      "inbound",
    );
    expect(request?.payload.params.variables).toEqual({
      contentType: "text/plain",
      filename: "managed-note.txt",
      size: mediaBytes.byteLength,
    });
    socket.message({
      ...inboundBase(),
      id: uuid(282),
      type: "rpc.result",
      correlationId: request?.correlationId,
      payload: {
        ok: true,
        result: {
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: "https://uploads.linear.app/signed?opaque=1",
                assetUrl: "https://uploads.linear.app/asset/opaque",
                headers: [
                  { key: "Content-Type", value: "text/plain" },
                  { key: "x-linear-upload", value: "opaque" },
                ],
              },
            },
          },
        },
      },
    });

    await expect(upload).resolves.toMatchObject({
      details: { assetUrl: "https://uploads.linear.app/asset/opaque" },
    });
    expect(uploadFetch).toHaveBeenCalledOnce();
    expect(uploadFetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    await registration.service.stop?.(serviceContext(stateDir));
    await expect(tool.execute("after-upload-stop", uploadInput))
      .rejects.toMatchObject({ code: "not_available" });
  });

  it("makes one fresh signed attempt from a persisted revoked fence", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "unblock-linear-persisted-revoked-"));
    const pluginStateDir = join(stateDir, "plugins", "unblock-linear");
    await mkdir(pluginStateDir, { recursive: true });
    const journal = await RelayJournal.open(join(pluginStateDir, "relay-journal.json"));
    await journal.setLifecycle("revoked");
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const socketFactory = vi.fn(() => {
      const socket = sockets.shift();
      if (socket === undefined) throw new Error("Unexpected reconnect attempt");
      return socket;
    });
    const registration = createIntegrationRegistration(apiWithRuntime(runtimeFixture()), {
      resolveSecret: async () => JSON.stringify(PRIVATE_JWK),
      socketFactory,
    });

    const startup = registration.service.start(serviceContext(stateDir));
    await waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(1));
    firstSocket.close(1006, "Probe failed");
    await startup;
    expect(registration.getState().statusState).toBe("revoked");

    const reconnect = registration.reconnect();
    await waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2));
    secondSocket.open();

    await expect(reconnect).resolves.toEqual({ status: "connected" });
    expect(registration.getState().statusState).toBe("connected");
    expect((await RelayJournal.open(join(pluginStateDir, "relay-journal.json"))).getLifecycle())
      .toEqual({ fence: "normal" });
    await registration.service.stop?.(serviceContext(stateDir));
  });

  it("keeps an active failed reconnect revoked without retrying", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "unblock-linear-active-revoked-"));
    const firstSocket = new FakeSocket();
    const probeSocket = new FakeSocket();
    const sockets = [firstSocket, probeSocket];
    const socketFactory = vi.fn(() => {
      const socket = sockets.shift();
      if (socket === undefined) throw new Error("Unexpected reconnect attempt");
      return socket;
    });
    const registration = createIntegrationRegistration(apiWithRuntime(runtimeFixture()), {
      resolveSecret: async () => JSON.stringify(PRIVATE_JWK),
      socketFactory,
    });
    await registration.service.start(serviceContext(stateDir));
    firstSocket.open();
    firstSocket.message({
      ...inboundBase(),
      id: uuid(281),
      type: "control",
      payload: { kind: "installation.revoked" },
    });
    await waitFor(() => expect(registration.getState().statusState).toBe("revoked"));
    await waitFor(() => expect(firstSocket.sentAtClose).toHaveLength(1));
    await vi.waitFor(async () => {
      await expect(access(join(stateDir, "plugins", "unblock-linear", "relay-writer.lock")))
        .rejects.toThrow();
    });

    const reconnect = registration.reconnect();
    await waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2));
    probeSocket.close(1006, "Probe failed");

    await expect(reconnect).rejects.toThrow("Unblock Linear remains revoked");
    expect(registration.getState()).toMatchObject({
      running: false,
      connected: false,
      statusState: "revoked",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socketFactory).toHaveBeenCalledTimes(2);
    await registration.service.stop?.(serviceContext(stateDir));
  });

  it("compacts a delivery after its authenticated terminal acknowledgement", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "unblock-linear-terminal-ack-"));
    const socket = new FakeSocket();
    const registration = createIntegrationRegistration(apiWithRuntime(runtimeFixture()), {
      resolveSecret: async () => JSON.stringify(PRIVATE_JWK),
      socketFactory: () => socket,
    });
    await registration.service.start(serviceContext(stateDir));
    socket.open();
    const deliveryId = uuid(72);
    socket.message({
      ...inboundBase(),
      id: uuid(172),
      type: "delivery",
      sessionId: "linear-session",
      idempotencyKey: deliveryId,
      payload: {
        deliveryId,
        action: "created",
        sequence: 1,
        teamId: "linear-team",
        prompt: "Work",
      },
    });
    await waitFor(() => expect(sentFrames(socket)).toContainEqual(expect.objectContaining({
      type: "delivery.status",
      payload: expect.objectContaining({ deliveryId, status: "completed" }),
    })));

    socket.message({
      ...inboundBase(),
      id: uuid(272),
      type: "delivery.ack",
      sessionId: "linear-session",
      idempotencyKey: deliveryId,
      payload: { deliveryId, status: "completed" },
    });

    const journalPath = join(stateDir, "plugins", "unblock-linear", "relay-journal.json");
    await vi.waitFor(async () => {
      const snapshot = JSON.parse(await readFile(journalPath, "utf8")) as {
        deliveries?: Record<string, unknown>;
      };
      expect(snapshot.deliveries?.[deliveryId]).toBeUndefined();
    });
    socket.message({
      ...inboundBase(),
      id: uuid(372),
      type: "delivery.ack",
      sessionId: "linear-session",
      idempotencyKey: deliveryId,
      payload: { deliveryId, status: "completed" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socket.sentAtClose).toEqual([]);
    await registration.service.stop?.(serviceContext(stateDir));
  });

  it("persists the canceled terminal status before shutdown closes the transport", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "unblock-linear-shutdown-"));
    const socket = new FakeSocket();
    let observedSignal: AbortSignal | undefined;
    const registration = createIntegrationRegistration(apiWithRuntime(runtimeFixture(async (input) => {
      const signal = input.abortSignal;
      if (signal === undefined) throw new Error("Expected delivery abort signal");
      observedSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { meta: { durationMs: 1 } };
    })), {
      resolveSecret: async () => JSON.stringify(PRIVATE_JWK),
      socketFactory: () => socket,
    });
    await registration.service.start(serviceContext(stateDir));
    socket.open();
    const deliveryId = uuid(71);
    socket.message({
      ...inboundBase(),
      id: uuid(171),
      type: "delivery",
      sessionId: "linear-session",
      idempotencyKey: deliveryId,
      payload: {
        deliveryId,
        action: "created",
        sequence: 1,
        teamId: "linear-team",
        prompt: "Work",
      },
    });
    await waitFor(() => expect(observedSignal).toBeDefined());

    await registration.service.stop?.(serviceContext(stateDir));

    expect(observedSignal?.aborted).toBe(true);
    const framesBeforeClose = (socket.sentAtClose[0] ?? []).map((value) =>
      parseOutboundRelayFrame(value));
    expect(framesBeforeClose).toContainEqual(expect.objectContaining({
      type: "delivery.status",
      payload: expect.objectContaining({ deliveryId, status: "canceled" }),
    }));
  });

  it("rejects an in-flight RPC when the service stops", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "unblock-linear-rpc-stop-"));
    const socket = new FakeSocket();
    const registration = createIntegrationRegistration(apiWithRuntime(runtimeFixture()), {
      resolveSecret: async () => JSON.stringify(PRIVATE_JWK),
      socketFactory: () => socket,
    });
    await registration.service.start(serviceContext(stateDir));
    socket.open();
    const invocation = requireTool(registration).execute("pending-rpc", {
      action: "graphql",
      document: "query { viewer { id } }",
    });
    await waitFor(() => expect(sentFrames(socket).some((frame) => frame.type === "rpc.request")).toBe(true));
    const rejected = expect(invocation).rejects.toThrow("Linear is unavailable");

    await registration.service.stop?.(serviceContext(stateDir));

    await rejected;
  });

  it.each([
    ["session", { sessionId: "linear-session", payload: { kind: "session.stop" } }],
    ["team", { payload: { kind: "team.access_removed", teamId: "linear-team" } }],
    ["terminal", { payload: { kind: "installation.revoked" } }],
  ] as const)("routes %s cancellation to the active delivery", async (kind, control) => {
    const stateDir = await mkdtemp(join(tmpdir(), `unblock-linear-${kind}-`));
    const socket = new FakeSocket();
    let observedSignal: AbortSignal | undefined;
    const runtime = runtimeFixture(async (input) => {
      const signal = input.abortSignal;
      if (signal === undefined) throw new Error("Expected delivery abort signal");
      observedSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { meta: { durationMs: 1 } };
    });
    const registration = createIntegrationRegistration(apiWithRuntime(runtime), {
      resolveSecret: async () => JSON.stringify(PRIVATE_JWK),
      socketFactory: () => socket,
    });
    await registration.service.start(serviceContext(stateDir));
    socket.open();
    const deliveryId = uuid(kind === "session" ? 61 : kind === "team" ? 62 : 63);
    socket.message({
      ...inboundBase(),
      id: uuid(kind === "session" ? 161 : kind === "team" ? 162 : 163),
      type: "delivery",
      sessionId: "linear-session",
      idempotencyKey: deliveryId,
      payload: {
        deliveryId,
        action: "created",
        sequence: 1,
        teamId: "linear-team",
        prompt: "Work",
      },
    });
    await waitFor(() => expect(observedSignal).toBeDefined());
    socket.message({
      ...inboundBase(),
      id: uuid(kind === "session" ? 261 : kind === "team" ? 262 : 263),
      type: "control",
      ...control,
    });
    await waitFor(() => expect(observedSignal?.aborted).toBe(true));
    if (kind === "terminal") {
      await waitFor(() => expect(registration.getState().statusState).toBe("revoked"));
      await waitFor(() => expect(socket.sentAtClose).toHaveLength(1));
      await expect(requireTool(registration).execute("terminal", {
        action: "graphql",
        document: "query { viewer { id } }",
      })).rejects.toThrow("Linear relay is unavailable");
      await expect(requireTool(registration).execute("terminal-upload", {
        action: "upload",
        fileRef: "media://inbound/opaque_1",
      })).rejects.toMatchObject({ code: "not_available" });
      const journal = await RelayJournal.open(
        join(stateDir, "plugins", "unblock-linear", "relay-journal.json"),
      );
      expect(journal.getDelivery(deliveryId)).toMatchObject({
        status: "canceled",
        terminalAcknowledged: false,
      });
      expect(journal.getReplayEntries(deliveryId)).toContainEqual(expect.objectContaining({
        kind: "delivery_status",
        frame: expect.objectContaining({
          type: "delivery.status",
          payload: expect.objectContaining({ deliveryId, status: "canceled" }),
        }),
      }));
    }
    await registration.service.stop?.(serviceContext(stateDir));
  });
});
