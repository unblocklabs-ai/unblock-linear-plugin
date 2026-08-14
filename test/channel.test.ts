import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it } from "vitest";
import { unblockLinearPlugin } from "../src/channel.js";

const configured = {
  channels: {
    "unblock-linear": {
      origin: "https://linear-staging.unblocklabs.ai",
      agentId: "relay-agent",
      enrollmentGeneration: 1,
      devicePrivateKey: {
        source: "env",
        provider: "default",
        id: "SENSITIVE_PRIVATE_JWK",
      },
    },
  },
} as OpenClawConfig;

describe("Unblock Linear channel", () => {
  it("declares only its current channel capabilities", () => {
    expect(unblockLinearPlugin.id).toBe("unblock-linear");
    expect(unblockLinearPlugin.capabilities).toEqual({
      chatTypes: ["direct"],
      threads: false,
      media: false,
      reply: false,
    });
    expect(unblockLinearPlugin).not.toHaveProperty("outbound");
    expect(unblockLinearPlugin.gateway?.startAccount).toBeTypeOf("function");
  });

  it.each([
    ["connected", true, "ready", false],
    ["reconnect_wait", false, "recovering", false],
    ["revoked", false, "blocked", true],
    ["enrollment_replaced", false, "blocked", true],
  ] as const)(
    "builds a distinct, content-free %s status snapshot",
    async (relayState, connected, lifecycle, terminalDisconnect) => {
    const account = unblockLinearPlugin.config.resolveAccount(configured);
    const snapshot = await unblockLinearPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg: configured,
      runtime: {
        accountId: "default",
        running: true,
        statusState: relayState,
        lastStartAt: 123,
        lastError: "must-not-leak",
      },
    });

    expect(snapshot).toEqual({
      accountId: "default",
      name: undefined,
      enabled: true,
      configured: true,
      running: true,
      connected,
      lifecycle,
      statusState: relayState,
      terminalDisconnect,
      lastStartAt: 123,
      lastStopAt: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain("relay-agent");
    expect(JSON.stringify(snapshot)).not.toContain("SENSITIVE_PRIVATE_JWK");
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
    },
  );

  it("doctor reports only missing configuration field names", async () => {
    const warnings = await unblockLinearPlugin.doctor?.collectPreviewWarnings?.({
      cfg: {
        channels: {
          "unblock-linear": {
            agentId: "relay-agent",
            devicePrivateKey: "must-not-leak",
          },
        },
      } as OpenClawConfig,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      "channels.unblock-linear account default is missing or has invalid origin.",
      "channels.unblock-linear account default is missing or has invalid enrollmentGeneration.",
      "channels.unblock-linear account default is missing or has invalid devicePrivateKey.",
    ]);
    expect(JSON.stringify(warnings)).not.toContain("relay-agent");
    expect(JSON.stringify(warnings)).not.toContain("must-not-leak");
  });

  it("registers only the single enrollment SecretRef target", () => {
    expect(
      unblockLinearPlugin.secrets?.secretTargetRegistryEntries?.map(
        (entry) => entry.pathPattern,
      ),
    ).toEqual(["channels.unblock-linear.devicePrivateKey"]);
  });
});
