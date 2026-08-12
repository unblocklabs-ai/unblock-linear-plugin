import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it } from "vitest";
import {
  applyUnblockLinearAccountConfig,
  DEFAULT_UNBLOCK_LINEAR_ACCOUNT_ID,
  inspectUnblockLinearAccount,
  listUnblockLinearAccountIds,
  resolveDefaultUnblockLinearAccountId,
  resolveUnblockLinearAccount,
} from "../src/config.js";

const enrolledDevice = {
  origin: "https://linear-staging.unblocklabs.ai",
  agentId: "worker-relay-agent",
  deviceId: "device_1",
  enrollmentGeneration: 3,
  devicePrivateKey: {
    source: "env",
    provider: "default",
    id: "UNBLOCK_LINEAR_DEVICE_PRIVATE_KEY",
  },
} as const;

describe("Unblock Linear account config", () => {
  it("uses the default account and keeps the Worker relay identity separate", () => {
    const cfg = {
      channels: {
        "unblock-linear": enrolledDevice,
      },
    } as OpenClawConfig;

    const account = resolveUnblockLinearAccount(cfg);

    expect(account.accountId).toBe(DEFAULT_UNBLOCK_LINEAR_ACCOUNT_ID);
    expect(account.relayAgentId).toBe("worker-relay-agent");
    expect(account).not.toHaveProperty("openclawAgentId");
    expect(account.configured).toBe(true);
  });

  it("uses accountId only as the OpenClaw binding identity", () => {
    const cfg = {
      channels: {
        "unblock-linear": {
          ...enrolledDevice,
          accountId: "secondary",
          accounts: {
            primary: { agentId: "primary-relay" },
          },
        },
      },
    } as OpenClawConfig;

    expect(listUnblockLinearAccountIds(cfg)).toEqual(["secondary"]);
    expect(resolveDefaultUnblockLinearAccountId(cfg)).toBe("secondary");
    expect(resolveUnblockLinearAccount(cfg, "primary").relayAgentId).toBe(
      "worker-relay-agent",
    );
  });

  it("reports invalid enrollment fields without exposing configured values", () => {
    const privateKey = "private-jwk-json";
    const cfg = {
      channels: {
        "unblock-linear": {
          origin: "https://example.com",
          agentId: "invalid relay id",
          deviceId: "",
          enrollmentGeneration: 0,
          devicePrivateKey: privateKey,
        },
      },
    } as OpenClawConfig;

    const account = resolveUnblockLinearAccount(cfg);
    const inspection = inspectUnblockLinearAccount(cfg);

    expect(account.configured).toBe(false);
    expect(account.configurationIssues).toEqual([
      "origin",
      "agentId",
      "deviceId",
      "enrollmentGeneration",
      "devicePrivateKey",
    ]);
    expect(JSON.stringify(inspection)).not.toContain(privateKey);
    expect(inspection).not.toHaveProperty("origin");
    expect(inspection).not.toHaveProperty("relayAgentId");
    expect(inspection).not.toHaveProperty("deviceId");
  });

  it("writes one enrollment at the channel root", () => {
    const next = applyUnblockLinearAccountConfig({
      cfg: {
        channels: {
          "unblock-linear": {
            accounts: { legacy: { agentId: "legacy-relay" } },
          },
        },
      } as OpenClawConfig,
      accountId: "staging",
      input: {
        ...enrolledDevice,
        accounts: { ignored: { agentId: "ignored-relay" } },
      },
    });

    expect(resolveDefaultUnblockLinearAccountId(next)).toBe("staging");
    expect(resolveUnblockLinearAccount(next, "staging")).toMatchObject({
      accountId: "staging",
      relayAgentId: "worker-relay-agent",
      configured: true,
    });
    expect(next.channels?.["unblock-linear"]).not.toHaveProperty("accounts");
  });

  it("rejects malformed, plaintext, and unsupported SecretRefs", () => {
    const base = {
      origin: enrolledDevice.origin,
      agentId: enrolledDevice.agentId,
      deviceId: enrolledDevice.deviceId,
      enrollmentGeneration: enrolledDevice.enrollmentGeneration,
    };
    const resolveKey = (devicePrivateKey: unknown, secrets?: OpenClawConfig["secrets"]) =>
      resolveUnblockLinearAccount({
        channels: { "unblock-linear": { ...base, devicePrivateKey } },
        secrets,
      } as OpenClawConfig);

    expect(resolveKey("private-jwk-json").configurationIssues).toContain(
      "devicePrivateKey",
    );
    expect(
      resolveKey({ source: "env", provider: "default", id: "lowercase" })
        .configurationIssues,
    ).toContain("devicePrivateKey");
    expect(
      resolveKey({ source: "file", provider: "missing", id: "value" })
        .configurationIssues,
    ).toContain("devicePrivateKey");
    expect(
      resolveKey(
        { source: "file", provider: "keys", id: "value" },
        { providers: { keys: { source: "env" } } },
      ).configurationIssues,
    ).toContain("devicePrivateKey");
  });

  it("accepts a valid configured non-env SecretRef without resolving it", () => {
    const ref = { source: "file", provider: "keys", id: "value" } as const;
    const account = resolveUnblockLinearAccount({
      channels: { "unblock-linear": { ...enrolledDevice, devicePrivateKey: ref } },
      secrets: {
        providers: {
          keys: { source: "file", path: "/run/secrets/linear", mode: "singleValue" },
        },
      },
    } as OpenClawConfig);

    expect(account.configured).toBe(true);
    expect(account.devicePrivateKey).toBe(ref);
  });
});
