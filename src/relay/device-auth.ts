import { createPrivateKey, randomBytes as nodeRandomBytes, sign } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

const encoder = new TextEncoder();

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TIMESTAMP_PATTERN = /^[1-9][0-9]{12,15}$/u;

export const DEVICE_AUTH_HEADERS = {
  timestamp: "X-Relay-Timestamp",
  nonce: "X-Relay-Nonce",
  enrollmentGeneration: "X-Relay-Enrollment-Generation",
  signature: "X-Relay-Signature",
} as const;

export interface DeviceAuthCanonicalMessageInput {
  method: string;
  path: string;
  agentId: string;
  enrollmentGeneration: number;
  timestamp: number;
  nonce: string;
}

export interface DeviceAuthUpgradeInput {
  origin: string;
  agentId: string;
  enrollmentGeneration: number;
  privateKeyJwk: JsonWebKey;
}

export interface DeviceAuthDependencies {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

export interface SignedDeviceUpgrade {
  url: URL;
  headers: Record<(typeof DEVICE_AUTH_HEADERS)[keyof typeof DEVICE_AUTH_HEADERS], string>;
}

export class DeviceAuthConfigurationError extends Error {
  constructor(readonly code: "invalid_identity" | "invalid_generation" | "invalid_timestamp" | "invalid_nonce" | "invalid_origin" | "invalid_private_key" | "invalid_randomness") {
    super("Invalid enrollment authentication configuration");
    this.name = "DeviceAuthConfigurationError";
  }
}

function isValidIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value);
}

function isValidPath(value: string): boolean {
  if (value.length < 1 || value.length > 2_048 || !value.startsWith("/")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return true;
}

function isCanonicalBase64Url(value: unknown, expectedLength: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === expectedLength && decoded.toString("base64url") === value;
}

/** Validates exactly the private JWK shape accepted for P-256 enrollment signing. */
export function parsePrivateP256Jwk(value: unknown): JsonWebKey {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeviceAuthConfigurationError("invalid_private_key");
  }
  const key = value as Record<string, unknown>;
  const keyOps = key.key_ops;
  const validKeyOps = keyOps === undefined || (
    Array.isArray(keyOps)
    && keyOps.length === 1
    && keyOps[0] === "sign"
  );
  if (
    key.kty !== "EC"
    || key.crv !== "P-256"
    || !isCanonicalBase64Url(key.x, 32)
    || !isCanonicalBase64Url(key.y, 32)
    || !isCanonicalBase64Url(key.d, 32)
    || (key.alg !== undefined && key.alg !== "ES256")
    || (key.use !== undefined && key.use !== "sig")
    || !validKeyOps
  ) {
    throw new DeviceAuthConfigurationError("invalid_private_key");
  }
  return key as JsonWebKey;
}

/** Produces the exact v1 bytes verified by the Worker, with no trailing newline. */
export function createDeviceAuthCanonicalMessage(input: DeviceAuthCanonicalMessageInput): Uint8Array {
  if (input.method !== "GET" || !isValidPath(input.path)) {
    throw new DeviceAuthConfigurationError("invalid_origin");
  }
  if (!isValidIdentifier(input.agentId)) {
    throw new DeviceAuthConfigurationError("invalid_identity");
  }
  if (!Number.isSafeInteger(input.enrollmentGeneration) || input.enrollmentGeneration < 1) {
    throw new DeviceAuthConfigurationError("invalid_generation");
  }
  if (!Number.isSafeInteger(input.timestamp) || !TIMESTAMP_PATTERN.test(String(input.timestamp))) {
    throw new DeviceAuthConfigurationError("invalid_timestamp");
  }
  if (!NONCE_PATTERN.test(input.nonce) || !isCanonicalBase64Url(input.nonce, 32)) {
    throw new DeviceAuthConfigurationError("invalid_nonce");
  }

  return encoder.encode([
    "unblocked-linear-worker:enrollment-auth:v1",
    `method:${input.method}`,
    `path:${input.path}`,
    `agent-id:${input.agentId}`,
    `enrollment-generation:${String(input.enrollmentGeneration)}`,
    `timestamp:${String(input.timestamp)}`,
    `nonce:${input.nonce}`,
  ].join("\n"));
}

function createRelayWebSocketUrl(origin: string, agentId: string): URL {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    throw new DeviceAuthConfigurationError("invalid_origin");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new DeviceAuthConfigurationError("invalid_origin");
  }
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return new URL(
    `/v1/relay/agents/${encodeURIComponent(agentId)}/ws`,
    base,
  );
}

/**
 * Creates one authenticated relay upgrade. Calling it again always asks the
 * injected randomness source for a fresh 32-byte nonce.
 */
export function createSignedDeviceUpgrade(
  input: DeviceAuthUpgradeInput,
  dependencies: DeviceAuthDependencies = {},
): SignedDeviceUpgrade {
  const timestamp = (dependencies.now ?? Date.now)();
  const randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  const nonceBytes = randomBytes(32);
  if (!(nonceBytes instanceof Uint8Array) || nonceBytes.byteLength !== 32) {
    throw new DeviceAuthConfigurationError("invalid_randomness");
  }
  const nonce = Buffer.from(nonceBytes).toString("base64url");
  const url = createRelayWebSocketUrl(input.origin, input.agentId);
  const canonicalMessage = createDeviceAuthCanonicalMessage({
    method: "GET",
    path: url.pathname,
    agentId: input.agentId,
    enrollmentGeneration: input.enrollmentGeneration,
    timestamp,
    nonce,
  });

  let signature: Buffer;
  try {
    signature = sign("sha256", canonicalMessage, {
      key: createPrivateKey({ key: parsePrivateP256Jwk(input.privateKeyJwk), format: "jwk" }),
      dsaEncoding: "ieee-p1363",
    });
  } catch (error) {
    if (error instanceof DeviceAuthConfigurationError) throw error;
    throw new DeviceAuthConfigurationError("invalid_private_key");
  }
  if (signature.byteLength !== 64) {
    throw new DeviceAuthConfigurationError("invalid_private_key");
  }

  return {
    url,
    headers: {
      [DEVICE_AUTH_HEADERS.timestamp]: String(timestamp),
      [DEVICE_AUTH_HEADERS.nonce]: nonce,
      [DEVICE_AUTH_HEADERS.enrollmentGeneration]: String(input.enrollmentGeneration),
      [DEVICE_AUTH_HEADERS.signature]: signature.toString("base64url"),
    },
  };
}
