import { createReadStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";
import { resolveMediaBufferPath } from "openclaw/plugin-sdk/media-store";
import { resolveRequiredConfiguredSecretRefInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import WebSocket, { type RawData } from "ws";
import { resolveUnblockLinearAccount, type ResolvedUnblockLinearAccount } from "./config.js";
import { DeliveryExecutor } from "./delivery/executor.js";
import { RpcBridge } from "./linear/rpc-bridge.js";
import {
  createLinearToolFactory,
  LinearToolError,
  type DurableRpcPort,
  type LinearGraphqlRpcRequest,
  type LinearRpcResult,
  type RelayIdentity,
} from "./linear/tool.js";
import type {
  ManagedMediaPort,
  ManagedUploadDependencies,
  UploadFetch,
  UploadWorkflowPort,
} from "./linear/upload.js";
import { managedMediaId } from "./linear/media-ref.js";
import { parsePrivateP256Jwk, type SignedDeviceUpgrade } from "./relay/device-auth.js";
import { RelayJournal } from "./relay/journal.js";
import {
  RelayService,
  RelayServiceError,
  type RelayServiceState,
  type RelaySocket,
  type RelaySocketFactory,
} from "./relay/service.js";

const SERVICE_ID = "unblock-linear-relay";
const SECRET_PATH = "channels.unblock-linear.devicePrivateKey";
const STATE_SUBDIRECTORY = join("plugins", "unblock-linear");

type ConfiguredAccount = ResolvedUnblockLinearAccount & Required<Pick<
  ResolvedUnblockLinearAccount,
  | "origin"
  | "relayAgentId"
  | "enrollmentGeneration"
  | "devicePrivateKey"
>>;

export type IntegrationState = Readonly<{
  accountId?: string;
  running: boolean;
  connected: boolean;
  statusState: RelayServiceState;
}>;

export type IntegrationDependencies = Readonly<{
  env?: NodeJS.ProcessEnv;
  resolveSecret?: typeof resolveRequiredConfiguredSecretRefInputString;
  socketFactory?: RelaySocketFactory;
  resolveMediaPath?: typeof resolveMediaBufferPath;
  uploadFetch?: typeof globalThis.fetch;
}>;

export type IntegrationRegistration = Readonly<{
  service: Parameters<OpenClawPluginApi["registerService"]>[0];
  toolFactory: ReturnType<typeof createLinearToolFactory>;
  getState(): IntegrationState;
}>;

type ActiveIntegration = {
  relay: RelayService;
  rpc: RpcBridge;
  executor: DeliveryExecutor;
  journal: RelayJournal;
  upload: UploadRuntimeDependencies;
};

type UploadRuntimeDependencies = Omit<ManagedUploadDependencies, "requestFileUpload">;

class MutableDurableRpcPort implements DurableRpcPort {
  private delegate: DurableRpcPort | undefined;

  set(delegate: DurableRpcPort): void {
    this.delegate = delegate;
  }

  clear(delegate: DurableRpcPort): void {
    if (this.delegate === delegate) this.delegate = undefined;
  }

  getRelayIdentity(): RelayIdentity {
    return this.requireDelegate().getRelayIdentity();
  }

  getOrCreateRequest(
    invocationId: string,
    semanticFingerprint: string,
    create: () => LinearGraphqlRpcRequest,
    deliveryId?: string,
  ): Promise<LinearGraphqlRpcRequest> {
    return this.requireDelegate().getOrCreateRequest(
      invocationId,
      semanticFingerprint,
      create,
      deliveryId,
    );
  }

  executePersisted(
    invocationId: string,
    request: LinearGraphqlRpcRequest,
    signal?: AbortSignal,
  ): Promise<LinearRpcResult> {
    return this.requireDelegate().executePersisted(invocationId, request, signal);
  }

  consumeResult(invocationId: string, result: LinearRpcResult): Promise<void> {
    return this.requireDelegate().consumeResult(invocationId, result);
  }

  private requireDelegate(): DurableRpcPort {
    if (this.delegate === undefined) throw new Error("Linear relay is unavailable");
    return this.delegate;
  }
}

class MutableUploadDependencies implements UploadRuntimeDependencies {
  private delegate: UploadRuntimeDependencies | undefined;

  readonly media: ManagedMediaPort = {
    resolve: (fileRef) => this.requireDelegate().media.resolve(fileRef),
  };

  readonly fetch: UploadFetch = {
    put: (request) => this.requireDelegate().fetch.put(request),
  };

  readonly workflows: UploadWorkflowPort = {
    getUpload: (uploadId) => this.requireDelegate().workflows.getUpload(uploadId),
    recordUpload: (upload) => this.requireDelegate().workflows.recordUpload(upload),
    updateUpload: (uploadId, patch) => this.requireDelegate().workflows.updateUpload(uploadId, patch),
  };

  set(delegate: UploadRuntimeDependencies): void {
    this.delegate = delegate;
  }

  clear(delegate: UploadRuntimeDependencies): void {
    if (this.delegate === delegate) this.delegate = undefined;
  }

  private requireDelegate(): UploadRuntimeDependencies {
    if (this.delegate === undefined) {
      throw new LinearToolError(
        "not_available",
        "Linear managed file upload is not available yet.",
      );
    }
    return this.delegate;
  }
}

export function createIntegrationRegistration(
  api: OpenClawPluginApi,
  dependencies: IntegrationDependencies = {},
): IntegrationRegistration {
  const durableRpc = new MutableDurableRpcPort();
  const managedUpload = new MutableUploadDependencies();
  const resolveSecret = dependencies.resolveSecret ?? resolveRequiredConfiguredSecretRefInputString;
  const socketFactory = dependencies.socketFactory ?? createWebSocketRelaySocket;
  let active: ActiveIntegration | undefined;
  let state: IntegrationState = {
    running: false,
    connected: false,
    statusState: "stopped",
  };

  const updateState = (statusState: RelayServiceState, accountId?: string): void => {
    state = {
      ...(accountId === undefined ? {} : { accountId }),
      running: statusState !== "stopped" && statusState !== "revoked" &&
        statusState !== "enrollment_replaced",
      connected: statusState === "connected",
      statusState,
    };
  };

  const service: Parameters<OpenClawPluginApi["registerService"]>[0] = {
    id: SERVICE_ID,
    async start(ctx): Promise<void> {
      if (active !== undefined) return;
      const account = requireConfiguredAccount(resolveUnblockLinearAccount(ctx.config));
      const serializedPrivateKey = await resolveSecret({
        config: ctx.config,
        env: dependencies.env ?? process.env,
        value: account.devicePrivateKey,
        path: SECRET_PATH,
      });
      if (serializedPrivateKey === undefined) throw new Error("Unblock Linear credential is unavailable");

      let privateKeyValue: unknown;
      try {
        privateKeyValue = JSON.parse(serializedPrivateKey);
      } catch {
        throw new Error("Unblock Linear credential is invalid");
      }
      const privateKeyJwk = parsePrivateP256Jwk(privateKeyValue);

      const stateDirectory = join(ctx.stateDir, STATE_SUBDIRECTORY);
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const journal = await RelayJournal.open(join(stateDirectory, "relay-journal.json"));

      let executor: DeliveryExecutor | undefined;
      let rpc: RpcBridge | undefined;
      const relay = new RelayService({
        account: {
          origin: account.origin,
          agentId: account.relayAgentId,
          enrollmentGeneration: account.enrollmentGeneration,
          privateKeyJwk,
        },
        journal,
        leasePath: join(stateDirectory, "relay-writer.lock"),
        socketFactory,
        callbacks: {
          async onDelivery(frame): Promise<void> {
            if (executor === undefined) throw new Error("Linear delivery executor is unavailable");
            await executor.execute(frame);
          },
          async onRpcResult(frame, replay): Promise<void> {
            if (rpc === undefined) throw new Error("Linear RPC bridge is unavailable");
            await rpc.onRpcResult(frame, replay);
          },
          async onSessionStop(sessionId): Promise<void> {
            if (executor !== undefined && sessionId !== undefined) {
              await executor.handleSessionStop(sessionId);
            }
          },
          async onTeamAccessRemoved(teamId): Promise<void> {
            await executor?.handleTeamAccessRemoved(teamId);
          },
          async onInstallationRevoked(): Promise<void> {
            await rpc?.rejectTerminal("revoked");
          },
          async onEnrollmentReplaced(): Promise<void> {
            await rpc?.rejectTerminal("enrollment_replaced");
          },
          async onTerminal(): Promise<void> {
            await executor?.abortAllAndWaitOffline();
          },
          onStateChange(statusState): void {
            updateState(statusState, account.accountId);
            if ((statusState === "revoked" || statusState === "enrollment_replaced") && rpc !== undefined) {
              durableRpc.clear(rpc);
              if (active !== undefined) managedUpload.clear(active.upload);
            }
          },
        },
      });
      rpc = new RpcBridge({
        journal,
        relayIdentity: { agentId: account.relayAgentId },
        async sendPersisted(request): Promise<boolean> {
          try {
            await relay.send(request);
            return true;
          } catch (error) {
            if (error instanceof RelayServiceError && error.code === "not_connected") return false;
            throw error;
          }
        },
      });
      executor = new DeliveryExecutor({
        runtime: api.runtime,
        config: ctx.config,
        accountId: account.accountId,
        relayIdentity: { agentId: account.relayAgentId },
        relay,
        journal,
      });
      const upload = createUploadRuntimeDependencies(journal, {
        resolveMediaPath: dependencies.resolveMediaPath ?? resolveMediaBufferPath,
        fetch: dependencies.uploadFetch ?? globalThis.fetch,
      });
      const started: ActiveIntegration = { relay, rpc, executor, journal, upload };
      active = started;
      durableRpc.set(rpc);
      managedUpload.set(upload);
      updateState("starting", account.accountId);
      try {
        const didStart = await relay.start();
        if (!didStart) {
          const terminalState = relay.getState();
          await relay.stop();
          durableRpc.clear(rpc);
          managedUpload.clear(upload);
          if (active === started) active = undefined;
          updateState(
            terminalState === "revoked" || terminalState === "enrollment_replaced"
              ? terminalState
              : "stopped",
            account.accountId,
          );
        }
      } catch (error) {
        const lifecycle = journal.getLifecycle().fence;
        try {
          await relay.stop();
        } finally {
          durableRpc.clear(rpc);
          managedUpload.clear(upload);
          if (active === started) active = undefined;
          updateState(
            lifecycle === "revoked" || lifecycle === "enrollment_replaced" ? lifecycle : "stopped",
            account.accountId,
          );
        }
        throw error;
      }
    },
    async stop(): Promise<void> {
      const current = active;
      if (current === undefined) {
        updateState("stopped", state.accountId);
        return;
      }
      try {
        await current.executor.abortAllAndWait();
      } finally {
        try {
          await current.rpc.rejectTerminal("stopped");
          await current.relay.stop();
        } finally {
          durableRpc.clear(current.rpc);
          managedUpload.clear(current.upload);
          if (active === current) active = undefined;
          updateState("stopped", state.accountId);
        }
      }
    },
  };

  return {
    service,
    toolFactory: createLinearToolFactory({ rpc: durableRpc, upload: managedUpload }),
    getState: () => ({ ...state }),
  };
}

function createUploadRuntimeDependencies(
  workflows: RelayJournal,
  dependencies: Readonly<{
    resolveMediaPath: typeof resolveMediaBufferPath;
    fetch: typeof globalThis.fetch;
  }>,
): UploadRuntimeDependencies {
  return {
    workflows,
    media: {
      async resolve(fileRef) {
        const mediaId = managedMediaId(fileRef);
        if (mediaId === undefined) throw new Error("Invalid managed media reference");
        const filePath = await dependencies.resolveMediaPath(mediaId, "inbound");
        const fileStat = await stat(filePath);
        if (!fileStat.isFile() || !Number.isSafeInteger(fileStat.size) || fileStat.size < 0) {
          throw new Error("Invalid managed media file");
        }
        const filename = safeMediaBasename(filePath);
        const contentType = mimeTypeFromFilePath(filePath);
        return {
          size: fileStat.size,
          ...(filename === undefined ? {} : { filename }),
          ...(contentType === undefined ? {} : { contentType }),
          stream: async () => Readable.toWeb(createReadStream(filePath)),
        };
      },
    },
    fetch: {
      async put(request) {
        const response = await dependencies.fetch(request.url, {
          method: "PUT",
          headers: request.headers,
          body: request.body,
          redirect: request.redirect,
          duplex: "half",
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        return { status: response.status };
      },
    },
  };
}

function safeMediaBasename(filePath: string): string | undefined {
  const filename = basename(filePath);
  return filename.length > 0 && filename.length <= 512 && !/[\r\n\0]/u.test(filename)
    ? filename
    : undefined;
}

function requireConfiguredAccount(account: ResolvedUnblockLinearAccount): ConfiguredAccount {
  if (!account.enabled) throw new Error("Unblock Linear account is disabled");
  if (!account.configured || account.origin === undefined || account.relayAgentId === undefined ||
    account.enrollmentGeneration === undefined ||
    account.devicePrivateKey === undefined) {
    throw new Error("Unblock Linear account is not configured");
  }
  return {
    ...account,
    origin: account.origin,
    relayAgentId: account.relayAgentId,
    enrollmentGeneration: account.enrollmentGeneration,
    devicePrivateKey: account.devicePrivateKey,
  };
}

type RelaySocketListenerArguments =
  | [event: "open", listener: () => void]
  | [event: "message", listener: (data: string | ArrayBuffer) => void]
  | [event: "error", listener: (error: Error) => void]
  | [event: "close", listener: (code: number, reason: string | Buffer) => void]
  | [
    event: "unexpected-response",
    listener: (response: { statusCode: number; body?: string }) => Promise<void> | void,
  ];

const MAX_UNEXPECTED_RESPONSE_BYTES = 1_024;

function createWebSocketRelaySocket(upgrade: SignedDeviceUpgrade): RelaySocket {
  const socket = new WebSocket(upgrade.url, { headers: upgrade.headers });
  const on = (...[event, listener]: RelaySocketListenerArguments): unknown => {
    switch (event) {
      case "open":
        return socket.on("open", listener);
      case "message":
        return socket.on("message", (data) => listener(normalizeWebSocketMessage(data)));
      case "error":
        return socket.on("error", listener);
      case "close":
        return socket.on("close", listener);
      case "unexpected-response":
        return socket.on("unexpected-response", (_request, response) => {
          void forwardUnexpectedResponse(socket, response, listener).catch(() => undefined);
        });
    }
  };
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    terminate: () => socket.terminate(),
    on,
  };
}

async function forwardUnexpectedResponse(
  socket: WebSocket,
  response: IncomingMessage,
  listener: (response: { statusCode: number; body?: string }) => Promise<void> | void,
): Promise<void> {
  try {
    const body = await readBoundedResponseBody(response);
    await listener({
      statusCode: response.statusCode ?? 0,
      ...(body === undefined ? {} : { body }),
    });
  } finally {
    socket.terminate();
  }
}

async function readBoundedResponseBody(response: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      const buffer = Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_UNEXPECTED_RESPONSE_BYTES) {
        response.destroy();
        return undefined;
      }
      chunks.push(buffer);
    }
  } catch {
    return undefined;
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function normalizeWebSocketMessage(data: RawData): string | ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
