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
import {
  subscribeIntegrationState,
  type IntegrationState,
} from "./integration-status.js";

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
  | "starting"
  | "connected"
  | "reconnect_wait"
  | "revoked"
  | "enrollment_replaced";

function relayStatusState(runtime: Record<string, unknown> | undefined): RelayStatusState {
  const value = runtime?.statusState;
  return value === "starting" ||
    value === "connected" ||
    value === "reconnect_wait" ||
    value === "revoked" ||
    value === "enrollment_replaced"
    ? value
    : "stopped";
}

function relayLifecycle(state: RelayStatusState) {
  if (state === "starting") {
    return "starting" as const;
  }
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

function integrationRuntime(
  state: IntegrationState,
  timestamps: Readonly<{ lastStartAt: number | null; lastStopAt: number | null }>,
) {
  return {
    accountId: state.accountId ?? DEFAULT_UNBLOCK_LINEAR_ACCOUNT_ID,
    running: state.running,
    connected: state.connected,
    statusState: state.statusState,
    lastStartAt: timestamps.lastStartAt,
    lastStopAt: timestamps.lastStopAt,
  };
}

function buildAccountSnapshot(
  account: ResolvedUnblockLinearAccount,
  runtime: Record<string, unknown> | undefined,
) {
  const relayState = relayStatusState(runtime);
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
    running: runtimeBoolean(runtime, "running"),
    connected: relayState === "connected",
    lifecycle: relayLifecycle(relayState),
    statusState: relayState,
    terminalDisconnect:
      relayState === "revoked" || relayState === "enrollment_replaced",
    lastStartAt: runtimeTimestamp(runtime, "lastStartAt"),
    lastStopAt: runtimeTimestamp(runtime, "lastStopAt"),
  };
}

export const unblockLinearPlugin: ChannelPlugin<ResolvedUnblockLinearAccount> = {
  ...channelCore,
  status: {
    defaultRuntime,
    buildAccountSnapshot: ({ account, runtime }) =>
      buildAccountSnapshot(account, runtime as Record<string, unknown> | undefined),
  },
  gateway: {
    async startAccount(ctx): Promise<void> {
      let wasRunning = false;
      let lastStartAt = ctx.getStatus().lastStartAt ?? null;
      let lastStopAt = ctx.getStatus().lastStopAt ?? null;

      await new Promise<void>((resolve) => {
        const unsubscribe = subscribeIntegrationState((state) => {
          const now = Date.now();
          if (state.running && !wasRunning) lastStartAt = now;
          if (!state.running && wasRunning) lastStopAt = now;
          wasRunning = state.running;

          const runtime = integrationRuntime(state, { lastStartAt, lastStopAt });
          if (!ctx.abortSignal.aborted) ctx.setStatus(buildAccountSnapshot(ctx.account, runtime));
        });
        const stop = () => {
          unsubscribe();
          resolve();
        };
        if (ctx.abortSignal.aborted) stop();
        else ctx.abortSignal.addEventListener("abort", stop, { once: true });
      });
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
