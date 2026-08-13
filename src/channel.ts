import {
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import {
  applyUnblockLinearAccountConfig,
  DEFAULT_UNBLOCK_LINEAR_ACCOUNT_ID,
  inspectUnblockLinearAccount,
  listUnblockLinearAccountIds,
  resolveDefaultUnblockLinearAccountId,
  resolveUnblockLinearAccount,
  type ResolvedUnblockLinearAccount,
  unblockLinearChannelConfigSchema,
} from "./config.js";

const channelCore = {
  id: "unblock-linear",
  meta: {
    id: "unblock-linear",
    label: "Unblock Linear",
    selectionLabel: "Unblock Linear",
    blurb: "Runs Linear AgentSession work through OpenClaw.",
    docsPath: "/plugins/unblock-linear",
  },
  capabilities: {
    chatTypes: ["direct"],
    threads: false,
    media: false,
    reply: false,
  },
  configSchema: unblockLinearChannelConfigSchema,
  setup: {
    resolveAccountId: ({ accountId }: { accountId?: string }) =>
      accountId ?? DEFAULT_UNBLOCK_LINEAR_ACCOUNT_ID,
    applyAccountConfig: ({
      cfg,
      accountId,
      input,
    }: {
      cfg: OpenClawConfig;
      accountId: string;
      input: unknown;
    }) =>
      applyUnblockLinearAccountConfig({
        cfg,
        accountId,
        input,
      }),
  },
  config: {
    listAccountIds: listUnblockLinearAccountIds,
    resolveAccount: resolveUnblockLinearAccount,
    inspectAccount: inspectUnblockLinearAccount,
    defaultAccountId: resolveDefaultUnblockLinearAccountId,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    unconfiguredReason: (account) =>
      `Missing or invalid configuration: ${account.configurationIssues.join(", ")}`,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
} satisfies Pick<
  ChannelPlugin<ResolvedUnblockLinearAccount>,
  "id" | "meta" | "capabilities" | "configSchema" | "setup" | "config"
>;

const defaultRuntime = {
  accountId: DEFAULT_UNBLOCK_LINEAR_ACCOUNT_ID,
  configured: false,
  enabled: true,
  running: false,
  connected: false,
  statusState: "stopped",
  lifecycle: "stopped" as const,
  lastStartAt: null,
  lastStopAt: null,
};

function runtimeBoolean(runtime: Record<string, unknown> | undefined, key: string): boolean {
  return runtime?.[key] === true;
}

function runtimeTimestamp(
  runtime: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = runtime?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type RelayStatusState =
  | "stopped"
  | "connected"
  | "reconnect_wait"
  | "revoked"
  | "enrollment_replaced";

function relayStatusState(runtime: Record<string, unknown> | undefined): RelayStatusState {
  const value = runtime?.statusState;
  return value === "connected" ||
    value === "reconnect_wait" ||
    value === "revoked" ||
    value === "enrollment_replaced"
    ? value
    : "stopped";
}

function relayLifecycle(state: RelayStatusState) {
  if (state === "connected") {
    return "ready" as const;
  }
  if (state === "reconnect_wait") {
    return "recovering" as const;
  }
  if (state === "revoked" || state === "enrollment_replaced") {
    return "blocked" as const;
  }
  return "stopped" as const;
}

export const unblockLinearPlugin: ChannelPlugin<ResolvedUnblockLinearAccount> = {
  ...channelCore,
  status: {
    defaultRuntime,
    buildAccountSnapshot: ({ account, runtime }) => {
      const safeRuntime = runtime as Record<string, unknown> | undefined;
      const relayState = relayStatusState(safeRuntime);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        running: runtimeBoolean(safeRuntime, "running"),
        connected: relayState === "connected",
        lifecycle: relayLifecycle(relayState),
        statusState: relayState,
        terminalDisconnect:
          relayState === "revoked" || relayState === "enrollment_replaced",
        lastStartAt: runtimeTimestamp(safeRuntime, "lastStartAt"),
        lastStopAt: runtimeTimestamp(safeRuntime, "lastStopAt"),
      };
    },
  },
  doctor: {
    collectPreviewWarnings: ({ cfg }: { cfg: OpenClawConfig }) =>
      listUnblockLinearAccountIds(cfg).flatMap((accountId) => {
        const account = resolveUnblockLinearAccount(cfg, accountId);
        if (!account.enabled) {
          return [`channels.unblock-linear account ${accountId} is disabled.`];
        }
        return account.configurationIssues.map(
          (field) =>
            `channels.unblock-linear account ${accountId} is missing or has invalid ${field}.`,
        );
      }),
  },
  secrets: {
    secretTargetRegistryEntries: [
      {
        id: "channels.unblock-linear.devicePrivateKey",
        targetType: "channels.unblock-linear.devicePrivateKey",
        configFile: "openclaw.json",
        pathPattern: "channels.unblock-linear.devicePrivateKey",
        secretShape: "secret_input",
        expectedResolvedValue: "string",
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
      },
    ],
  },
};
