import { isDeepStrictEqual } from "node:util";
import type { ReplayEntry, RelayJournal } from "../relay/journal.js";
import type {
  DurableRpcPort,
  LinearGraphqlRpcRequest,
  LinearRpcResult,
  RelayIdentity,
} from "./tool.js";

export type RpcBridgeOptions = {
  journal: RelayJournal;
  relayIdentity: RelayIdentity;
  /** Attempts an already-journaled exact frame. False means offline, not failure. */
  sendPersisted(request: LinearGraphqlRpcRequest): Promise<boolean>;
  maximumRetries?: number;
};

export type RpcBridgeTerminalState = "revoked" | "enrollment_replaced" | "stopped";

export class RpcBridgeTerminalError extends Error {
  constructor(readonly state: RpcBridgeTerminalState) {
    super("Linear is unavailable until the plugin connection is restored.");
    this.name = "RpcBridgeTerminalError";
  }
}

type PendingInvocation = {
  resolve(result: LinearRpcResult): void;
  reject(error: unknown): void;
  retries: number;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class RpcBridge implements DurableRpcPort {
  private readonly pending = new Map<string, PendingInvocation>();
  private readonly maximumRetries: number;

  constructor(private readonly options: RpcBridgeOptions) {
    this.maximumRetries = options.maximumRetries ?? 1;
    if (!Number.isSafeInteger(this.maximumRetries) || this.maximumRetries < 0) {
      throw new Error("Invalid RPC retry limit");
    }
  }

  getRelayIdentity(): RelayIdentity {
    return { ...this.options.relayIdentity };
  }

  async getOrCreateRequest(
    invocationId: string,
    semanticFingerprint: string,
    create: () => LinearGraphqlRpcRequest,
    deliveryId?: string,
  ): Promise<LinearGraphqlRpcRequest> {
    if (invocationId.length < 1 || invocationId.length > 512) throw new Error("Invalid RPC invocation");
    const prior = this.options.journal.getRpcInvocation(invocationId);
    if (prior !== undefined) {
      if (prior.semanticFingerprint !== semanticFingerprint || prior.deliveryId !== deliveryId) {
        throw new Error("RPC invocation conflicts with durable state");
      }
      return prior.request as LinearGraphqlRpcRequest;
    }
    const created = create();
    const recorded = await this.options.journal.recordRpcInvocation(
      invocationId,
      semanticFingerprint,
      created,
      deliveryId,
    );
    return recorded.request as LinearGraphqlRpcRequest;
  }

  async executePersisted(
    invocationId: string,
    request: LinearGraphqlRpcRequest,
    signal?: AbortSignal,
  ): Promise<LinearRpcResult> {
    const recorded = this.options.journal.getRpcInvocation(invocationId);
    if (recorded === undefined || !isDeepStrictEqual(recorded.request, request)) {
      throw new Error("RPC request is not durably recorded");
    }
    if (recorded.result !== undefined &&
      (!isRetryable(recorded.result) || this.maximumRetries === 0)) {
      return recorded.result;
    }
    if (signal?.aborted) throw signal.reason ?? new Error("RPC invocation aborted");
    if (this.pending.has(invocationId)) throw new Error("RPC invocation is already pending");

    const result = new Promise<LinearRpcResult>((resolve, reject) => {
      const pending: PendingInvocation = { resolve, reject, retries: 0, ...(signal === undefined ? {} : { signal }) };
      if (signal !== undefined) {
        const onAbort = () => {
          this.pending.delete(invocationId);
          reject(signal.reason ?? new Error("RPC invocation aborted"));
        };
        pending.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(invocationId, pending);
    });

    try {
      if (recorded.result !== undefined) {
        await this.retry(invocationId, request);
      } else {
        await this.options.sendPersisted(request);
      }
    } catch (error) {
      this.rejectPending(invocationId, error);
    }
    return result;
  }

  async consumeResult(invocationId: string, result: LinearRpcResult): Promise<void> {
    const recorded = this.options.journal.getRpcInvocation(invocationId);
    if (recorded?.result === undefined || !isDeepStrictEqual(recorded.result, result)) {
      throw new Error("RPC result is not durably recorded");
    }
    await this.options.journal.consumeRpcInvocation(invocationId);
  }

  /** Pass directly as RelayServiceCallbacks.onRpcResult. */
  async onRpcResult(result: LinearRpcResult, _replay?: ReplayEntry): Promise<void> {
    const invocation = await this.options.journal.recordRpcResult(result);
    const pending = this.pending.get(invocation.invocationId);
    if (pending === undefined) return;
    if (isRetryable(result) && pending.retries < this.maximumRetries) {
      pending.retries += 1;
      setTimeout(() => {
        void this.retry(invocation.invocationId, invocation.request as LinearGraphqlRpcRequest)
          .catch((error) => this.rejectPending(invocation.invocationId, error));
      }, 0);
      return;
    }
    this.resolvePending(invocation.invocationId, result);
  }

  async rejectTerminal(state: RpcBridgeTerminalState): Promise<void> {
    if (state === "revoked") await this.options.journal.cancelAllRpcInvocations();
    const error = new RpcBridgeTerminalError(state);
    for (const invocationId of [...this.pending.keys()]) this.rejectPending(invocationId, error);
  }

  private async retry(invocationId: string, request: LinearGraphqlRpcRequest): Promise<void> {
    await this.options.journal.retryRpcInvocation(invocationId);
    await this.options.sendPersisted(request);
  }

  private resolvePending(invocationId: string, result: LinearRpcResult): void {
    const pending = this.takePending(invocationId);
    pending?.resolve(result);
  }

  private rejectPending(invocationId: string, error: unknown): void {
    const pending = this.takePending(invocationId);
    pending?.reject(error);
  }

  private takePending(invocationId: string): PendingInvocation | undefined {
    const pending = this.pending.get(invocationId);
    if (pending === undefined) return undefined;
    this.pending.delete(invocationId);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    return pending;
  }
}

function isRetryable(result: LinearRpcResult): boolean {
  return !result.payload.ok && result.payload.error.retryable;
}
