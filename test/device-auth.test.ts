import { createPublicKey, verify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createDeviceAuthCanonicalMessage,
  createSignedDeviceUpgrade,
  DEVICE_AUTH_HEADERS,
  DeviceAuthConfigurationError,
  parsePrivateP256Jwk,
} from "../src/relay/device-auth.js";

const privateJwk: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "z8ji77cSxUiWOdGk8KCSV0p1jLBJl4zgEDOj6R4DtMA",
  y: "ONa1i6bQCT76I1gwX_nxsJQnQss31Pkf8AAUP3RqAA0",
  d: "-Cn-hKIQXIuHi07HA0WnkgcZD_G5-1hOeR-ETgpKZDU",
};

const timestamp = 1_786_116_800_123;
const nonceBytes = Uint8Array.from({ length: 32 }, (_value, index) => index);
const expectedNonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const expectedCanonical = [
  "unblocked-linear-worker:enrollment-auth:v1",
  "method:GET",
  "path:/v1/relay/agents/agent-alpha/ws",
  "agent-id:agent-alpha",
  "enrollment-generation:7",
  `timestamp:${timestamp}`,
  `nonce:${expectedNonce}`,
].join("\n");

function signedUpgrade(randomBytes: (size: number) => Uint8Array = () => nonceBytes): ReturnType<typeof createSignedDeviceUpgrade> {
  return createSignedDeviceUpgrade({
    origin: "https://linear-staging.unblocklabs.ai",
    agentId: "agent-alpha",
    enrollmentGeneration: 7,
    privateKeyJwk: privateJwk,
  }, { now: () => timestamp, randomBytes });
}

function configurationError(action: () => unknown): DeviceAuthConfigurationError {
  try {
    action();
  } catch (error) {
    if (error instanceof DeviceAuthConfigurationError) return error;
    throw error;
  }
  throw new Error("Expected DeviceAuthConfigurationError");
}

describe("relay enrollment authentication", () => {
  it("matches the Worker's fixed enrollment-auth canonical vector byte-for-byte", () => {
    const canonical = createDeviceAuthCanonicalMessage({
      method: "GET",
      path: "/v1/relay/agents/agent-alpha/ws",
      agentId: "agent-alpha",
      enrollmentGeneration: 7,
      timestamp,
      nonce: expectedNonce,
    });

    expect(new TextDecoder().decode(canonical)).toBe(expectedCanonical);
    expect(new TextDecoder().decode(canonical).endsWith("\n")).toBe(false);
  });

  it("creates an exact signed relay upgrade using P1363 and unpadded base64url", () => {
    const upgrade = signedUpgrade();
    const signature = upgrade.headers[DEVICE_AUTH_HEADERS.signature];

    expect(upgrade.url.toString()).toBe("wss://linear-staging.unblocklabs.ai/v1/relay/agents/agent-alpha/ws");
    expect(upgrade.headers).toMatchObject({
      [DEVICE_AUTH_HEADERS.timestamp]: String(timestamp),
      [DEVICE_AUTH_HEADERS.nonce]: expectedNonce,
      [DEVICE_AUTH_HEADERS.enrollmentGeneration]: "7",
    });
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);

    expect(verify(
      "sha256",
      Buffer.from(expectedCanonical),
      { key: createPublicKey({ key: privateJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    )).toBe(true);
  });

  it("asks its randomness source for a fresh 32-byte nonce for every upgrade", () => {
    let calls = 0;
    const randomBytes = (size: number) => {
      calls += 1;
      return Uint8Array.from({ length: size }, () => calls);
    };

    const first = signedUpgrade(randomBytes);
    const second = signedUpgrade(randomBytes);
    expect(calls).toBe(2);
    expect(first.headers[DEVICE_AUTH_HEADERS.nonce]).not.toBe(second.headers[DEVICE_AUTH_HEADERS.nonce]);
  });

  it("rejects public, malformed, and incompatible private JWKs before signing", () => {
    expect(configurationError(() => parsePrivateP256Jwk({ ...privateJwk, d: undefined })).code).toBe("invalid_private_key");
    expect(configurationError(() => parsePrivateP256Jwk({ ...privateJwk, d: "padded=" })).code).toBe("invalid_private_key");
    expect(configurationError(() => parsePrivateP256Jwk({ ...privateJwk, key_ops: ["verify"] })).code).toBe("invalid_private_key");
    expect(() => parsePrivateP256Jwk({ ...privateJwk, crv: "P-384" })).toThrow(DeviceAuthConfigurationError);
  });

  it("accepts JSON-parsed unknown only after runtime P-256 validation", () => {
    const parsed: unknown = JSON.parse(JSON.stringify(privateJwk));
    expect(parsePrivateP256Jwk(parsed)).toEqual(privateJwk);
    expect(configurationError(() => parsePrivateP256Jwk(JSON.parse('{"kty":"EC"}'))).code)
      .toBe("invalid_private_key");
    expect(configurationError(() => parsePrivateP256Jwk([privateJwk])).code).toBe("invalid_private_key");
  });

  it("rejects nonconforming clock and randomness dependencies", () => {
    expect(configurationError(() => signedUpgrade(() => new Uint8Array(31))).code).toBe("invalid_randomness");
    expect(configurationError(() => createSignedDeviceUpgrade({
      origin: "https://linear-staging.unblocklabs.ai",
      agentId: "agent-alpha",
      enrollmentGeneration: 7,
      privateKeyJwk: privateJwk,
    }, { now: () => 42, randomBytes: () => nonceBytes })).code).toBe("invalid_timestamp");
  });
});
