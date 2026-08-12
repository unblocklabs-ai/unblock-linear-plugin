import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RpcBridge, RpcBridgeTerminalError } from "../src/linear/rpc-bridge.js";
import type { LinearGraphqlRpcRequest, LinearRpcResult } from "../src/linear/tool.js";
import { JournalError, RelayJournal } from "../src/relay/journal.js";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const fingerprint = (value = "a") => `sha256:${value.repeat(43)}`;

function request(id = 1): LinearGraphqlRpcRequest {
  return {
    v: 1,
    id: uuid(id),
    type: "rpc.request",
    agentId: "agent",
    deviceId: "device",
    timestamp: "2026-08-12T12:00:00.000Z",
    correlationId: uuid(1_000 + id),
    idempotencyKey: uuid(2_000 + id),
    payload: {
      method: "linear.graphql",
      params: { contextId: "opaque-context", document: "query { viewer { id } }", variables: {} },
    },
  };
}

function result(
  requestFrame: LinearGraphqlRpcRequest,
  payload: LinearRpcResult["payload"],
  id = 9_000,
): LinearRpcResult {
  return {
    v: 1,
    id: uuid(id),
    type: "rpc.result",
    agentId: requestFrame.agentId,
    deviceId: requestFrame.deviceId,
    timestamp: "2026-08-12T12:00:01.000Z",
    correlationId: requestFrame.correlationId,
    payload,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "unblock-linear-rpc-"));
  const path = join(directory, "relay.json");
  return { path, journal: await RelayJournal.open(path) };
}

describe("RpcBridge", () => {
  it("recovers the exact request and correlated result after restart, then consumes after handoff", async () => {
    const { path, journal } = await fixture();
    const sendPersisted = vi.fn(async () => true);
    const bridge = new RpcBridge({ journal, relayIdentity: { agentId: "agent", deviceId: "device" }, sendPersisted });
    const created = request();
    expect(await bridge.getOrCreateRequest("tool-call-1", fingerprint(), () => created)).toEqual(created);
    const received = result(created, {
      ok: true,
      result: { data: { issue: null }, errors: [{ message: "partial" }] },
    });
    await bridge.onRpcResult(received);
    await journal.removeReplay(`rpc:${created.correlationId}`);

    const recoveredJournal = await RelayJournal.open(path);
    const recoveredBridge = new RpcBridge({
      journal: recoveredJournal,
      relayIdentity: { agentId: "agent", deviceId: "device" },
      sendPersisted,
    });
    const recovered = await recoveredBridge.getOrCreateRequest("tool-call-1", fingerprint(), () => {
      throw new Error("must not create a replacement identity");
    });
    expect(recovered).toEqual(created);
    await expect(recoveredBridge.executePersisted("tool-call-1", recovered)).resolves.toEqual(received);
    expect(sendPersisted).not.toHaveBeenCalled();

    await recoveredBridge.consumeResult("tool-call-1", received);
    expect(recoveredJournal.getRpcInvocation("tool-call-1")).toBeUndefined();
  });

  it("waits for durable callback recording and retries once with the same exact frame", async () => {
    const { journal } = await fixture();
    const sent: LinearGraphqlRpcRequest[] = [];
    const bridge = new RpcBridge({
      journal,
      relayIdentity: { agentId: "agent", deviceId: "device" },
      sendPersisted: vi.fn(async (frame) => {
        sent.push(frame);
        return sent.length === 1;
      }),
      maximumRetries: 1,
    });
    const persisted = await bridge.getOrCreateRequest("tool-call-2", fingerprint(), () => request(2));
    const pending = bridge.executePersisted("tool-call-2", persisted);
    expect(sent).toEqual([persisted]);

    const retryable = result(persisted, {
      ok: false,
      error: { code: "retryable", message: "private", retryable: true },
    }, 9_001);
    await bridge.onRpcResult(retryable);
    await journal.removeReplay(`rpc:${persisted.correlationId}`);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual(persisted);
    expect(journal.getReplayEntries()[0]?.frame).toEqual(persisted);
    await expect(Promise.race([
      pending.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 10)),
    ])).resolves.toBe("pending");

    const completed = result(persisted, { ok: true, result: { data: { viewer: { id: "me" } } } }, 9_002);
    await bridge.onRpcResult(completed);
    await expect(pending).resolves.toEqual(completed);
    expect(journal.getRpcInvocation("tool-call-2")?.result).toEqual(completed);
  });

  it("keeps unauthorized results durable without polling", async () => {
    const { journal } = await fixture();
    const sendPersisted = vi.fn(async () => true);
    const bridge = new RpcBridge({ journal, relayIdentity: { agentId: "agent", deviceId: "device" }, sendPersisted });
    const persisted = await bridge.getOrCreateRequest("tool-call-3", fingerprint(), () => request(3));
    const pending = bridge.executePersisted("tool-call-3", persisted);
    const unauthorized = result(persisted, {
      ok: false,
      error: { code: "unauthorized", message: "private worker content", retryable: false },
    });

    await bridge.onRpcResult(unauthorized);
    await expect(pending).resolves.toEqual(unauthorized);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sendPersisted).toHaveBeenCalledTimes(1);
    expect(journal.getRpcInvocation("tool-call-3")?.result).toEqual(unauthorized);
  });

  it("keeps the original invocation pending when offline until reconnect replay produces a result", async () => {
    const { journal } = await fixture();
    const sendPersisted = vi.fn(async () => false);
    const bridge = new RpcBridge({
      journal,
      relayIdentity: { agentId: "agent", deviceId: "device" },
      sendPersisted,
    });
    const persisted = await bridge.getOrCreateRequest("tool-call-offline", fingerprint(), () => request(5));
    const pending = bridge.executePersisted("tool-call-offline", persisted);

    await expect(Promise.race([
      pending.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 10)),
    ])).resolves.toBe("pending");
    expect(journal.getReplayEntries()[0]?.frame).toEqual(persisted);

    const replayed = result(persisted, { ok: true, result: { data: { viewer: { id: "me" } } } });
    await bridge.onRpcResult(replayed);
    await expect(pending).resolves.toEqual(replayed);
  });

  it("cleans up an aborted waiter without deleting its durable request", async () => {
    const { journal } = await fixture();
    const bridge = new RpcBridge({
      journal,
      relayIdentity: { agentId: "agent", deviceId: "device" },
      sendPersisted: vi.fn(async () => false),
    });
    const persisted = await bridge.getOrCreateRequest("tool-call-abort", fingerprint(), () => request(6));
    const controller = new AbortController();
    const aborted = bridge.executePersisted("tool-call-abort", persisted, controller.signal);
    controller.abort(new Error("caller stopped"));
    await expect(aborted).rejects.toThrow("caller stopped");
    expect(journal.getRpcInvocation("tool-call-abort")?.request).toEqual(persisted);

    const resumed = bridge.executePersisted("tool-call-abort", persisted);
    const received = result(persisted, { ok: true, result: { data: { resumed: true } } });
    await bridge.onRpcResult(received);
    await expect(resumed).resolves.toEqual(received);
  });

  it("durably cancels every RPC before rejecting live waiters on installation revocation", async () => {
    const { journal } = await fixture();
    const bridge = new RpcBridge({
      journal,
      relayIdentity: { agentId: "agent", deviceId: "device" },
      sendPersisted: vi.fn(async () => false),
    });
    const persisted = await bridge.getOrCreateRequest("tool-call-terminal", fingerprint(), () => request(7));
    const pending = bridge.executePersisted("tool-call-terminal", persisted);

    await bridge.rejectTerminal("revoked");
    await expect(pending).rejects.toEqual(expect.objectContaining({
      name: "RpcBridgeTerminalError",
      state: "revoked",
      message: "Linear is unavailable until the plugin connection is restored.",
    }));
    await expect(pending).rejects.toBeInstanceOf(RpcBridgeTerminalError);
    expect(journal.getRpcInvocation("tool-call-terminal")).toBeUndefined();
    expect(journal.getReplayEntries()).toEqual([]);
  });

  it("preserves durable work for terminal states other than installation revocation", async () => {
    const { journal } = await fixture();
    const bridge = new RpcBridge({
      journal,
      relayIdentity: { agentId: "agent", deviceId: "device" },
      sendPersisted: vi.fn(async () => false),
    });
    const persisted = await bridge.getOrCreateRequest("tool-call-device", fingerprint(), () => request(8));
    const pending = bridge.executePersisted("tool-call-device", persisted);

    await bridge.rejectTerminal("device_replaced");

    await expect(pending).rejects.toMatchObject({ state: "device_replaced" });
    expect(journal.getRpcInvocation("tool-call-device")?.request).toEqual(persisted);
  });

  it("refuses to reuse one durable namespace for changed semantics", async () => {
    const { journal } = await fixture();
    const bridge = new RpcBridge({
      journal,
      relayIdentity: { agentId: "agent", deviceId: "device" },
      sendPersisted: vi.fn(async () => false),
    });
    const persisted = await bridge.getOrCreateRequest("namespaced-call", fingerprint(), () => request(9));
    const replacement = vi.fn(() => request(10));

    await expect(bridge.getOrCreateRequest("namespaced-call", fingerprint("b"), replacement))
      .rejects.toThrow("RPC invocation conflicts with durable state");
    expect(replacement).not.toHaveBeenCalled();
    expect(journal.getRpcInvocation("namespaced-call")?.request).toEqual(persisted);
  });

  it("rejects an uncorrelated callback without resolving the invocation", async () => {
    const { journal } = await fixture();
    const bridge = new RpcBridge({
      journal,
      relayIdentity: { agentId: "agent", deviceId: "device" },
      sendPersisted: vi.fn(async () => true),
    });
    const persisted = await bridge.getOrCreateRequest("tool-call-4", fingerprint(), () => request(4));
    const wrong = { ...result(persisted, { ok: true, result: {} }), correlationId: uuid(9_999) };
    await expect(bridge.onRpcResult(wrong)).rejects.toBeInstanceOf(JournalError);
    expect(journal.getRpcInvocation("tool-call-4")?.result).toBeUndefined();
  });
});
