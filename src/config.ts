import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  isSecretRef,
  isValidSecretRef,
} from "openclaw/plugin-sdk/secret-input";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";

export const UNBLOCK_LINEAR_CHANNEL_ID = "unblock-linear";
export const DEFAULT_UNBLOCK_LINEAR_ACCOUNT_ID = "default";

export const UNBLOCK_LINEAR_ORIGINS = [
  "https://linear-staging.unblocklabs.ai",
  "https://linear.unblocklabs.ai",
] as const;

export type UnblockLinearOrigin = (typeof UNBLOCK_LINEAR_ORIGINS)[number];

export type ResolvedUnblockLinearAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  origin?: UnblockLinearOrigin;
  /** Worker relay identity. OpenClaw agent selection remains channel-binding owned. */
  relayAgentId?: string;
  deviceId?: string;
  enrollmentGeneration?: number;
  devicePrivateKey?: SecretRef;
  configurationIssues: string[];
};

type RawAccountConfig = Record<string, unknown>;

export const unblockLinearEntryConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
} as const;

const relayIdSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_-]+$",
} as const;

export const unblockLinearChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      enabled: { type: "boolean", default: true },
      accountId: { type: "string", default: DEFAULT_UNBLOCK_LINEAR_ACCOUNT_ID },
      origin: { type: "string", enum: UNBLOCK_LINEAR_ORIGINS },
      agentId: {
        ...relayIdSchema,
        description:
          "Worker relay identity only; OpenClaw agent routing uses normal channel bindings.",
      },
      deviceId: relayIdSchema,
      enrollmentGeneration: { type: "integer", minimum: 1 },
      devicePrivateKey: {
        type: "object",
        additionalProperties: false,
        required: ["source", "provider", "id"],
        properties: {
          source: { type: "string", enum: ["env", "file", "exec"] },
          provider: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]{0,63}$",
          },
          id: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readEnabled(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

function readOrigin(value: unknown): UnblockLinearOrigin | undefined {
  return UNBLOCK_LINEAR_ORIGINS.find((origin) => origin === value);
}

function readRelayId(value: unknown): string | undefined {
  const id = readString(value);
  return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
}

function readEnrollmentGeneration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function getChannelSection(cfg: OpenClawConfig): RawAccountConfig {
  const channels = isRecord(cfg.channels) ? cfg.channels : {};
  const section = channels[UNBLOCK_LINEAR_CHANNEL_ID];
  return isRecord(section) ? section : {};
}

function readDevicePrivateKey(
  cfg: OpenClawConfig,
  value: unknown,
): SecretRef | undefined {
  if (!isSecretRef(value) || !isValidSecretRef(value)) {
    return undefined;
  }

  const provider = cfg.secrets?.providers?.[value.provider];
  if (provider) {
    return provider.source === value.source ? value : undefined;
  }

  const defaultEnvProvider = cfg.secrets?.defaults?.env?.trim() || "default";
  return value.source === "env" && value.provider === defaultEnvProvider
    ? value
    : undefined;
}

function collectConfigurationIssues(
  cfg: OpenClawConfig,
  raw: RawAccountConfig,
): string[] {
  const issues: string[] = [];
  if (!readOrigin(raw.origin)) {
    issues.push("origin");
  }
  if (!readRelayId(raw.agentId)) {
    issues.push("agentId");
  }
  if (!readRelayId(raw.deviceId)) {
    issues.push("deviceId");
  }
  if (!readEnrollmentGeneration(raw.enrollmentGeneration)) {
    issues.push("enrollmentGeneration");
  }
  if (!readDevicePrivateKey(cfg, raw.devicePrivateKey)) {
    issues.push("devicePrivateKey");
  }
  return issues;
}

export function listUnblockLinearAccountIds(cfg: OpenClawConfig): string[] {
  const section = getChannelSection(cfg);
  return [readString(section.accountId) ?? DEFAULT_UNBLOCK_LINEAR_ACCOUNT_ID];
}

export function resolveDefaultUnblockLinearAccountId(cfg: OpenClawConfig): string {
  const section = getChannelSection(cfg);
  return readString(section.accountId) ?? DEFAULT_UNBLOCK_LINEAR_ACCOUNT_ID;
}

export function resolveUnblockLinearAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedUnblockLinearAccount {
  const resolvedAccountId =
    readString(accountId) ?? resolveDefaultUnblockLinearAccountId(cfg);
  const raw = getChannelSection(cfg);
  const configurationIssues = collectConfigurationIssues(cfg, raw);

  return {
    accountId: resolvedAccountId,
    name: readString(raw.name),
    enabled: readEnabled(raw.enabled),
    configured: configurationIssues.length === 0,
    origin: readOrigin(raw.origin),
    relayAgentId: readRelayId(raw.agentId),
    deviceId: readRelayId(raw.deviceId),
    enrollmentGeneration: readEnrollmentGeneration(raw.enrollmentGeneration),
    devicePrivateKey: readDevicePrivateKey(cfg, raw.devicePrivateKey),
    configurationIssues,
  };
}

export function inspectUnblockLinearAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
) {
  const account = resolveUnblockLinearAccount(cfg, accountId);
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
    configurationIssues: account.configurationIssues,
  };
}

export function applyUnblockLinearAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: unknown;
}): OpenClawConfig {
  const next = structuredClone(params.cfg);
  const channels = isRecord(next.channels) ? next.channels : {};
  const section = isRecord(channels[UNBLOCK_LINEAR_CHANNEL_ID])
    ? channels[UNBLOCK_LINEAR_CHANNEL_ID]
    : {};

  const input = isRecord(params.input) ? params.input : {};
  const { accounts: _unsupportedAccounts, ...singleEnrollment } = input;
  const { accounts: _existingAccounts, ...singleSection } = section;
  channels[UNBLOCK_LINEAR_CHANNEL_ID] = {
    ...singleSection,
    ...singleEnrollment,
    enabled: true,
    accountId: params.accountId,
  };
  next.channels = channels;
  return next;
}
