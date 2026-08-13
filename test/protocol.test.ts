import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseInboundRelayFrame,
  parseOutboundRelayFrame,
  parseRelayFrame,
  RelayProtocolError,
  relayFrameSchema,
  UnexpectedRelayFrameDirectionError,
} from "../src/relay/protocol.js";

const MAX_RELAY_FRAME_BYTES = 64 * 1024;

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/protocol/${name}`, import.meta.url), "utf8")) as unknown;
}

function protocolError(action: () => unknown): RelayProtocolError {
  try {
    action();
  } catch (error) {
    if (error instanceof RelayProtocolError) return error;
    throw error;
  }
  throw new Error("Expected RelayProtocolError");
}

function directionError(action: () => unknown): UnexpectedRelayFrameDirectionError {
  try {
    action();
  } catch (error) {
    if (error instanceof UnexpectedRelayFrameDirectionError) return error;
    throw error;
  }
  throw new Error("Expected UnexpectedRelayFrameDirectionError");
}

describe("relay protocol v1", () => {
  it("accepts every Worker v1 frame family from the fixed parity fixtures", async () => {
    const inbound = await fixture("valid-inbound.json");
    const outbound = await fixture("valid-outbound.json");
    expect(Array.isArray(inbound)).toBe(true);
    expect(Array.isArray(outbound)).toBe(true);

    for (const frame of [...(inbound as unknown[]), ...(outbound as unknown[])]) {
      expect(relayFrameSchema.safeParse(frame).success).toBe(true);
    }
  });

  it("rejects invalid parity fixtures", async () => {
    const invalid = await fixture("invalid-frames.json");
    expect(Array.isArray(invalid)).toBe(true);

    for (const item of invalid as Array<{ frame: unknown }>) {
      expect(relayFrameSchema.safeParse(item.frame).success).toBe(false);
      expect(() => parseRelayFrame(JSON.stringify(item.frame))).toThrow(RelayProtocolError);
    }
  });

  it("accepts only Worker-to-plugin frame families on the inbound path", async () => {
    const inbound = await fixture("valid-inbound.json") as unknown[];
    const outbound = await fixture("valid-outbound.json") as unknown[];

    for (const frame of inbound) {
      expect(parseInboundRelayFrame(JSON.stringify(frame)).type).toMatch(/^(delivery|control|rpc\.result|delivery\.ack)$/u);
    }
    for (const frame of outbound) {
      expect(directionError(() => parseInboundRelayFrame(JSON.stringify(frame))).frameType).toMatch(/^(delivery\.accept|delivery\.status|activity|rpc\.request)$/u);
    }
  });

  it("accepts only plugin-to-Worker frame families on the outbound path", async () => {
    const inbound = await fixture("valid-inbound.json") as unknown[];
    const outbound = await fixture("valid-outbound.json") as unknown[];

    for (const frame of outbound) {
      expect(parseOutboundRelayFrame(JSON.stringify(frame)).type).toMatch(/^(delivery\.accept|delivery\.status|activity|rpc\.request)$/u);
    }
    for (const frame of inbound) {
      expect(directionError(() => parseOutboundRelayFrame(JSON.stringify(frame))).frameType).toMatch(/^(delivery|control|rpc\.result|delivery\.ack)$/u);
    }
  });

  it("enforces the exact UTF-8 64 KiB limit before JSON schema validation", async () => {
    const [graphqlFixture] = (await fixture("valid-outbound.json") as Array<Record<string, unknown>>)
      .filter((frame) => frame.type === "rpc.request");
    const payload = graphqlFixture.payload as {
      method: "linear.graphql";
      params: { contextId: string; document: string; variables: Record<string, never> };
    };
    const overhead = new TextEncoder().encode(JSON.stringify({
      ...graphqlFixture,
      payload: { ...payload, params: { ...payload.params, document: "" } },
    })).byteLength;
    const atLimit = {
      ...graphqlFixture,
      payload: {
        ...payload,
        params: { ...payload.params, document: "a".repeat(MAX_RELAY_FRAME_BYTES - overhead) },
      },
    };
    const tooLarge = {
      ...atLimit,
      payload: {
        ...atLimit.payload,
        params: { ...atLimit.payload.params, document: `${atLimit.payload.params.document}é` },
      },
    };

    expect(new TextEncoder().encode(JSON.stringify(atLimit)).byteLength).toBe(MAX_RELAY_FRAME_BYTES);
    expect(parseRelayFrame(JSON.stringify(atLimit))).toMatchObject({ type: "rpc.request" });
    expect(new TextEncoder().encode(JSON.stringify(tooLarge)).byteLength).toBeGreaterThan(MAX_RELAY_FRAME_BYTES);
    expect(protocolError(() => parseRelayFrame(JSON.stringify(tooLarge))).code).toBe("frame_too_large");
  });

  it("rejects invalid UTF-8 ArrayBuffer payloads", () => {
    expect(protocolError(() => parseRelayFrame(new Uint8Array([0xff]).buffer)).code).toBe("invalid_json");
  });

  it("matches the Worker by rejecting non-finite values before they can enter a relay frame", async () => {
    const rpcResult = (await fixture("valid-inbound.json") as Array<Record<string, unknown>>)
      .find((frame) => frame.type === "rpc.result");
    if (rpcResult === undefined) throw new Error("Expected rpc.result fixture");
    const nonFinite = {
      ...rpcResult,
      payload: { ok: true, result: Infinity },
    };
    expect(relayFrameSchema.safeParse(nonFinite).success).toBe(false);
    const raw = JSON.stringify({ ...rpcResult, payload: { ok: true, result: 0 } })
      .replace('"result":0', '"result":1e999');
    expect(protocolError(() => parseRelayFrame(raw)).code).toBe("invalid_frame");
  });
});
