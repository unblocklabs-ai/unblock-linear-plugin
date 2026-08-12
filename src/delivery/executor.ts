import { randomUUID } from "node:crypto";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type {
  DeliveryRecord,
  OpenClawSessionTarget,
  RelayJournal,
  SessionBinding,
} from "../relay/journal.js";
import type { InboundRelayFrame, OutboundRelayFrame } from "../relay/protocol.js";
import {
  LINEAR_RUN_BINDING_KEY,
  withLinearRunBindingFallback,
  type LinearRunBinding,
} from "../linear/run-binding.js";
import {
  captureDeliveryRecoveryBaseline,
  createDeliveryRecoveryInspector,
  type DeliveryRecoveryDecision,
  type DeliveryRecoveryInspector,
} from "./recovery.js";

export type { DeliveryRecoveryDecision, DeliveryRecoveryInspector } from "./recovery.js";

const CHANNEL_ID = "unblock-linear";
const RECONCILIATION_INSTRUCTION =
  "This turn is resuming after an interrupted process. Inspect the existing session and reconcile prior tool effects before repeating any side effect.";

type DeliveryFrame = Extract<InboundRelayFrame, { type: "delivery" }>;
type DeliveryAcceptFrame = Extract<OutboundRelayFrame, { type: "delivery.accept" }>;
type DeliveryStatusFrame = Extract<OutboundRelayFrame, { type: "delivery.status" }>;
type ActivityFrame = Extract<OutboundRelayFrame, { type: "activity" }>;
type AgentActivity = ActivityFrame["payload"]["activity"];
type EmbeddedRunInput = Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];
type EmbeddedRunResult = Awaited<ReturnType<PluginRuntime["agent"]["runEmbeddedAgent"]>>;

/** The RelayService surface used here. Activity/status methods persist before transport. */
export type RelayPort = {
  send(frame: DeliveryAcceptFrame): Promise<void>;
  sendActivity(frame: ActivityFrame, deliveryId: string): Promise<boolean>;
  sendDeliveryStatus(frame: DeliveryStatusFrame): Promise<boolean>;
};

export type DeliveryJournalPort = Pick<
  RelayJournal,
  | "getBinding"
  | "getDelivery"
  | "getReplayEntries"
  | "bindSession"
  | "recordDelivery"
  | "updateDelivery"
  | "addReplay"
  | "removeCanceledSessionRpcs"
>;

/** A full PluginRuntime satisfies this deliberately narrow injected surface. */
export type DeliveryRuntimePort = {
  channel: {
    routing: Pick<PluginRuntime["channel"]["routing"], "resolveAgentRoute">;
    inbound: Pick<PluginRuntime["channel"]["inbound"], "buildContext">;
    session: Pick<PluginRuntime["channel"]["session"], "recordInboundSession">;
  };
  agent: Pick<
    PluginRuntime["agent"],
    | "runEmbeddedAgent"
    | "resolveAgentWorkspaceDir"
    | "resolveAgentDir"
    | "resolveAgentTimeoutMs"
    | "ensureAgentWorkspace"
  > & {
    session: Pick<
      PluginRuntime["agent"]["session"],
      "resolveStorePath" | "getSessionEntry"
    >;
  };
};

export type DeliveryExecutionResult = {
  deliveryId: string;
  outcome: "completed" | "failed" | "canceled";
  binding: SessionBinding;
  recovered: boolean;
};

export class DeliveryExecutorError extends Error {
  constructor(readonly code: "busy" | "conflict" | "missing_binding") {
    super(`Delivery executor ${code.replaceAll("_", " ")}`);
    this.name = "DeliveryExecutorError";
  }
}

export type DeliveryExecutorOptions = {
  runtime: DeliveryRuntimePort;
  config: OpenClawConfig;
  accountId: string;
  relayIdentity: {
    agentId: string;
    deviceId: string;
  };
  relay: RelayPort;
  journal: DeliveryJournalPort;
  inspectRecovery?: DeliveryRecoveryInspector;
  now?: () => Date;
  createId?: () => string;
};

type ActiveDelivery = {
  frame: DeliveryFrame;
  binding?: SessionBinding;
  controller: AbortController;
  offlineTerminal: boolean;
  promise?: Promise<DeliveryExecutionResult>;
};

export class DeliveryExecutor {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private active: ActiveDelivery | undefined;

  constructor(private readonly options: DeliveryExecutorOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  execute(frame: DeliveryFrame): Promise<DeliveryExecutionResult> {
    if (this.active) {
      if (this.active.frame.payload.deliveryId === frame.payload.deliveryId &&
        sameDelivery(this.active.frame, frame)) {
        if (this.active.promise) return this.active.promise;
      }
      throw new DeliveryExecutorError("busy");
    }

    const controller = new AbortController();
    const active: ActiveDelivery = { frame, controller, offlineTerminal: false };
    active.promise = this.executeOwned(active).finally(() => {
      if (this.active === active) this.active = undefined;
    });
    this.active = active;
    return active.promise;
  }

  async handleSessionStop(linearSessionId: string): Promise<boolean> {
    const active = this.active;
    if (!active || active.frame.sessionId !== linearSessionId) return false;
    active.controller.abort(new Error("Linear session stopped"));
    await this.options.journal.removeCanceledSessionRpcs(linearSessionId);
    return true;
  }

  async abortAll(): Promise<boolean> {
    const active = this.active;
    if (!active) return false;
    active.controller.abort(new Error("Linear relay access terminated"));
    await this.options.journal.removeCanceledSessionRpcs(active.frame.sessionId);
    return true;
  }

  async abortAllAndWait(): Promise<boolean> {
    const active = this.active;
    if (!active) return false;
    active.controller.abort(new Error("Linear relay access terminated"));
    await this.options.journal.removeCanceledSessionRpcs(active.frame.sessionId);
    await active.promise;
    return true;
  }

  /** Persists cancellation before returning when relay transport is terminal. */
  async abortAllAndWaitOffline(): Promise<boolean> {
    const active = this.active;
    if (!active) return false;
    active.offlineTerminal = true;
    active.controller.abort(new Error("Linear relay access terminated"));
    await this.options.journal.removeCanceledSessionRpcs(active.frame.sessionId);
    await active.promise;
    return true;
  }

  async handleTeamAccessRemoved(teamId: string): Promise<boolean> {
    const active = this.active;
    if (!active || active.frame.payload.teamId !== teamId) return false;
    active.controller.abort(new Error("Linear team access removed"));
    await this.options.journal.removeCanceledSessionRpcs(active.frame.sessionId);
    return true;
  }

  /** Only an explicit caller may label text as a genuine user elicitation. */
  async emitElicitation(input: { deliveryId: string; body: string }): Promise<boolean> {
    const active = this.active;
    if (!active || active.frame.payload.deliveryId !== input.deliveryId ||
      active.controller.signal.aborted || !active.binding) return false;
    await this.emitActivity(active.frame, { type: "elicitation", body: bounded(input.body, 8_000) });
    return true;
  }

  private async executeOwned(active: ActiveDelivery): Promise<DeliveryExecutionResult> {
    const frame = active.frame;
    const priorDelivery = this.options.journal.getDelivery(frame.payload.deliveryId);
    let binding = this.options.journal.getBinding(frame.sessionId);
    if (!binding && frame.payload.action === "prompted") {
      throw new DeliveryExecutorError("missing_binding");
    }
    if (priorDelivery && !deliveryMatchesFrame(priorDelivery, frame)) {
      throw new DeliveryExecutorError("conflict");
    }
    if (binding && !bindingMatchesFrame(binding, frame)) {
      throw new DeliveryExecutorError("conflict");
    }

    let delivery = priorDelivery;
    if (!delivery) {
      delivery = await this.options.journal.recordDelivery({
        deliveryId: frame.payload.deliveryId,
        sessionId: frame.sessionId,
        teamId: frame.payload.teamId,
        idempotencyKey: frame.idempotencyKey,
        action: frame.payload.action,
        sequence: frame.payload.sequence,
        ...(frame.payload.issueId === undefined ? {} : { issueId: frame.payload.issueId }),
        prompt: frame.payload.prompt,
        status: "offered",
        terminalAcknowledged: false,
        toolRecovery: { state: "none", reconciliationRequired: false },
        recordedAt: this.now().toISOString(),
      });
    }

    if (!binding) {
      binding = await this.createBinding(frame);
    }
    active.binding = binding;
    if (delivery.openclawSessionId !== binding.openclawSessionId) {
      delivery = await this.options.journal.updateDelivery(frame.payload.deliveryId, {
        openclawSessionId: binding.openclawSessionId,
      });
    }

    await this.options.relay.send(this.acceptanceFrame(frame, binding));
    if (delivery.status === "offered") {
      delivery = await this.options.journal.updateDelivery(frame.payload.deliveryId, {
        status: "accepted",
      });
    }

    const terminalStatus = deliveryTerminalStatus(delivery) ??
      this.pendingTerminalStatus(frame.payload.deliveryId);
    if (terminalStatus) {
      if (delivery.status !== terminalStatus) {
        await this.options.journal.updateDelivery(frame.payload.deliveryId, {
          status: terminalStatus,
        });
      }
      return {
        deliveryId: frame.payload.deliveryId,
        outcome: terminalStatus,
        binding,
        recovered: true,
      };
    }

    const recovery = priorDelivery
      ? await this.inspectRecovery(delivery, binding)
      : { kind: "resume" as const };
    await this.sendStartedIfNeeded(frame, delivery);

    if (recovery.kind === "completed") {
      if (recovery.transcriptWatermark) {
        await this.options.journal.updateDelivery(frame.payload.deliveryId, {
          transcriptWatermark: recovery.transcriptWatermark,
        });
      }
      await this.emitActivity(frame, {
        type: "response",
        body: bounded(recovery.response, 32_000),
      });
      await this.sendTerminal(frame, "completed");
      return { deliveryId: frame.payload.deliveryId, outcome: "completed", binding, recovered: true };
    }

    return this.runDelivery({
      active,
      delivery,
      binding,
      recovery,
      recovered: priorDelivery !== undefined,
    });
  }

  private async createBinding(frame: DeliveryFrame): Promise<SessionBinding> {
    const route = this.options.runtime.channel.routing.resolveAgentRoute({
      cfg: this.options.config,
      channel: CHANNEL_ID,
      accountId: this.options.accountId,
      peer: { kind: "direct", id: frame.sessionId },
      teamId: frame.payload.teamId,
    });
    const storePath = this.options.runtime.agent.session.resolveStorePath(undefined, {
      agentId: route.agentId,
    });
    const ctx = await this.options.runtime.channel.inbound.buildContext({
      channel: CHANNEL_ID,
      accountId: this.options.accountId,
      provider: CHANNEL_ID,
      surface: CHANNEL_ID,
      messageId: frame.id,
      messageIdFull: `${CHANNEL_ID}:${frame.id}`,
      timestamp: Date.parse(frame.timestamp),
      from: `${CHANNEL_ID}:${frame.sessionId}`,
      sender: {
        id: frame.sessionId,
        name: "Linear",
        displayLabel: "Linear",
      },
      conversation: {
        kind: "direct",
        id: frame.sessionId,
        label: "Linear AgentSession",
      },
      route: {
        routeSessionKey: route.sessionKey,
        dispatchSessionKey: route.sessionKey,
        accountId: this.options.accountId,
        agentId: route.agentId,
      },
      reply: {
        to: frame.sessionId,
        originatingTo: frame.sessionId,
      },
      message: {
        rawBody: frame.payload.prompt,
        body: frame.payload.prompt,
        bodyForAgent: frame.payload.prompt,
        commandBody: frame.payload.prompt,
        inboundEventKind: "user_request",
        sourceModality: "text",
      },
      extra: {
        UnblockLinearDeliveryId: frame.payload.deliveryId,
        UnblockLinearSessionId: frame.sessionId,
        UnblockLinearTeamId: frame.payload.teamId,
      },
    });
    let recordError: unknown;
    const metadataTasks: Promise<unknown>[] = [];
    await this.options.runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx,
      createIfMissing: true,
      updateLastRoute: {
        sessionKey: route.sessionKey,
        channel: CHANNEL_ID,
        to: frame.sessionId,
        accountId: this.options.accountId,
      },
      onRecordError: (error) => {
        recordError = error;
      },
      trackSessionMetaTask: (task) => {
        metadataTasks.push(task);
      },
    });
    await Promise.all(metadataTasks);
    if (recordError !== undefined) throw recordError;

    const entry = this.options.runtime.agent.session.getSessionEntry({
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      storePath,
      readConsistency: "latest",
    });
    if (entry === undefined) throw new DeliveryExecutorError("missing_binding");
    const sessionId = entry.sessionId;
    if (frame.payload.openclawSessionId !== undefined &&
      frame.payload.openclawSessionId !== sessionId) {
      throw new DeliveryExecutorError("conflict");
    }
    const sessionTarget: OpenClawSessionTarget = {
      agentId: route.agentId,
      sessionId,
      sessionKey: route.sessionKey,
      storePath,
    };
    return this.options.journal.bindSession({
      linearSessionId: frame.sessionId,
      teamId: frame.payload.teamId,
      openclawSessionId: sessionId,
      sessionTarget,
      routing: route,
      createdAt: this.now().toISOString(),
    });
  }

  private async runDelivery(input: {
    active: ActiveDelivery;
    delivery: DeliveryRecord;
    binding: SessionBinding;
    recovery: Extract<DeliveryRecoveryDecision, { kind: "resume" | "reconcile" }>;
    recovered: boolean;
  }): Promise<DeliveryExecutionResult> {
    const { active, binding } = input;
    const frame = active.frame;
    const agentId = binding.sessionTarget.agentId;
    const workspaceDir = this.options.runtime.agent.resolveAgentWorkspaceDir(
      this.options.config,
      agentId,
    );
    const agentDir = this.options.runtime.agent.resolveAgentDir(this.options.config, agentId);
    await this.options.runtime.agent.ensureAgentWorkspace({ dir: workspaceDir });

    let queuedLifecycleWork = Promise.resolve();
    let lastTool: { id?: string; name: string } | undefined;
    let lastActivityKey: string | undefined;
    const enqueue = (work: () => Promise<void>) => {
      queuedLifecycleWork = queuedLifecycleWork.then(work);
    };
    const onExecutionPhase: NonNullable<EmbeddedRunInput["onExecutionPhase"]> = (phase) => {
      if (phase.phase === "tool_execution_started") {
        const toolName = safeToolName(phase.tool);
        const key = `tool:${toolName}`;
        if (key === lastActivityKey) return;
        lastActivityKey = key;
        const tool = {
          ...(phase.toolCallId === undefined ? {} : { id: phase.toolCallId }),
          name: toolName,
        };
        lastTool = tool;
        enqueue(async () => {
          await this.options.journal.updateDelivery(frame.payload.deliveryId, {
            toolRecovery: {
              state: "started",
              ...(tool.id === undefined ? {} : { toolCallId: tool.id }),
              toolName,
              reconciliationRequired: true,
            },
          });
          await this.emitActivity(frame, {
            type: "action",
            action: toolName,
            parameter: "phase=tool_execution_started",
          });
        });
        return;
      }
      const body = safePhaseActivity(phase.phase);
      if (!body || body === lastActivityKey) return;
      lastActivityKey = body;
      enqueue(() => this.emitActivity(frame, { type: "thought", body, ephemeral: true }));
    };
    const onAgentToolResult: NonNullable<EmbeddedRunInput["onAgentToolResult"]> = (event) => {
      const completedTool = lastTool;
      if (!completedTool) return;
      enqueue(async () => {
        await this.options.journal.updateDelivery(frame.payload.deliveryId, {
          toolRecovery: {
            state: "completed",
            ...(completedTool.id === undefined ? {} : { toolCallId: completedTool.id }),
            toolName: safeToolName(event.toolName),
            reconciliationRequired: false,
          },
        });
      });
    };

    try {
      if (!input.recovered) {
        const transcriptWatermark = await captureDeliveryRecoveryBaseline(
          binding,
          frame.payload.deliveryId,
        );
        await this.options.journal.updateDelivery(frame.payload.deliveryId, { transcriptWatermark });
      }
      const runBinding = {
        linearSessionId: frame.sessionId,
        contextId: binding.openclawSessionId,
        deliveryId: frame.payload.deliveryId,
        teamId: frame.payload.teamId,
      } satisfies LinearRunBinding;
      const result = await withLinearRunBindingFallback({
        agentId,
        sessionId: binding.sessionTarget.sessionId,
        sessionKey: binding.sessionTarget.sessionKey,
      }, runBinding, () => this.options.runtime.agent.runEmbeddedAgent({
        sessionId: binding.sessionTarget.sessionId,
        sessionKey: binding.sessionTarget.sessionKey,
        sessionTarget: binding.sessionTarget,
        agentId,
        messageChannel: CHANNEL_ID,
        messageProvider: CHANNEL_ID,
        chatType: "direct",
        agentAccountId: this.options.accountId,
        trigger: "user",
        messageTo: frame.sessionId,
        senderId: frame.sessionId,
        currentChannelId: frame.sessionId,
        chatId: frame.sessionId,
        workspaceDir,
        agentDir,
        config: this.options.config,
        prompt: frame.payload.prompt,
        transcriptPrompt: frame.payload.prompt,
        currentInboundEventKind: "user_request",
        timeoutMs: this.options.runtime.agent.resolveAgentTimeoutMs({ cfg: this.options.config }),
        runId: frame.payload.deliveryId,
        abortSignal: active.controller.signal,
        toolBindings: {
          [LINEAR_RUN_BINDING_KEY]: runBinding,
        },
        ...(input.recovery.kind === "reconcile"
          ? { extraSystemPrompt: input.recovery.instruction?.trim() || RECONCILIATION_INSTRUCTION }
          : {}),
        onExecutionPhase,
        onAgentToolResult,
      }));
      await queuedLifecycleWork;
      if (active.controller.signal.aborted) {
        await this.sendTerminal(frame, "canceled");
        return { deliveryId: frame.payload.deliveryId, outcome: "canceled", binding, recovered: input.recovered };
      }
      const projected = projectFinalResult(result);
      if (projected.kind === "error") {
        await this.emitActivity(frame, { type: "error", body: "The OpenClaw run failed." });
        await this.sendTerminal(frame, "failed");
        return { deliveryId: frame.payload.deliveryId, outcome: "failed", binding, recovered: input.recovered };
      }
      if (projected.text) {
        await this.emitActivity(frame, { type: "response", body: bounded(projected.text, 32_000) });
      }
      await this.sendTerminal(frame, "completed");
      return { deliveryId: frame.payload.deliveryId, outcome: "completed", binding, recovered: input.recovered };
    } catch {
      await queuedLifecycleWork;
      if (active.controller.signal.aborted) {
        await this.sendTerminal(frame, "canceled");
        return { deliveryId: frame.payload.deliveryId, outcome: "canceled", binding, recovered: input.recovered };
      }
      await this.emitActivity(frame, { type: "error", body: "The OpenClaw run failed." });
      await this.sendTerminal(frame, "failed");
      return { deliveryId: frame.payload.deliveryId, outcome: "failed", binding, recovered: input.recovered };
    }
  }

  private inspectRecovery(
    delivery: DeliveryRecord,
    binding: SessionBinding,
  ): Promise<DeliveryRecoveryDecision> {
    const inspect = this.options.inspectRecovery ?? createDeliveryRecoveryInspector();
    return inspect({
      delivery,
      binding,
      transcriptWatermark: delivery.transcriptWatermark,
      toolRecovery: delivery.toolRecovery,
    });
  }

  private pendingTerminalStatus(deliveryId: string): "completed" | "failed" | "canceled" | undefined {
    for (const entry of this.options.journal.getReplayEntries(deliveryId)) {
      if (entry.kind !== "delivery_status" || entry.frame.type !== "delivery.status") continue;
      const status = entry.frame.payload.status;
      if (status === "completed" || status === "failed" || status === "canceled") return status;
    }
    return undefined;
  }

  private async sendStartedIfNeeded(frame: DeliveryFrame, delivery: DeliveryRecord): Promise<void> {
    const hasPendingStarted = this.options.journal.getReplayEntries(frame.payload.deliveryId).some(
      (entry) => entry.kind === "delivery_status" && entry.frame.type === "delivery.status" &&
        entry.frame.payload.status === "started",
    );
    if (delivery.status === "started") return;
    if (hasPendingStarted) {
      await this.options.journal.updateDelivery(frame.payload.deliveryId, { status: "started" });
      return;
    }
    await this.options.relay.sendDeliveryStatus(this.statusFrame(frame, "started"));
    await this.options.journal.updateDelivery(frame.payload.deliveryId, { status: "started" });
  }

  private async sendTerminal(
    frame: DeliveryFrame,
    status: "completed" | "failed" | "canceled",
  ): Promise<void> {
    const terminalFrame = this.statusFrame(frame, status);
    if (this.active?.frame === frame && this.active.offlineTerminal) {
      await this.options.journal.addReplay({
        key: `delivery-status:${frame.payload.deliveryId}:${status}`,
        kind: "delivery_status",
        frame: terminalFrame,
      });
    } else {
      await this.options.relay.sendDeliveryStatus(terminalFrame);
    }
    await this.options.journal.updateDelivery(frame.payload.deliveryId, {
      status,
      terminalAcknowledged: false,
    });
  }

  private async emitActivity(frame: DeliveryFrame, activity: AgentActivity): Promise<void> {
    const commandId = this.createId();
    await this.options.relay.sendActivity({
      ...this.envelope("activity"),
      sessionId: frame.sessionId,
      idempotencyKey: commandId,
      payload: { commandId, activity },
    }, frame.payload.deliveryId);
  }

  private acceptanceFrame(frame: DeliveryFrame, binding: SessionBinding): DeliveryAcceptFrame {
    return {
      ...this.envelope("delivery.accept"),
      sessionId: frame.sessionId,
      idempotencyKey: frame.idempotencyKey,
      payload: {
        deliveryId: frame.payload.deliveryId,
        openclawSessionId: binding.openclawSessionId,
      },
    };
  }

  private statusFrame(
    frame: DeliveryFrame,
    status: DeliveryStatusFrame["payload"]["status"],
  ): DeliveryStatusFrame {
    return {
      ...this.envelope("delivery.status"),
      sessionId: frame.sessionId,
      idempotencyKey: frame.idempotencyKey,
      payload: {
        deliveryId: frame.payload.deliveryId,
        status,
        summary: status === "completed" ? "Completed" : status === "failed" ? "Failed" :
          status === "canceled" ? "Canceled" : "Started",
      },
    };
  }

  private envelope<TType extends "delivery.accept" | "delivery.status" | "activity">(type: TType) {
    return {
      v: 1 as const,
      id: this.createId(),
      type,
      agentId: this.options.relayIdentity.agentId,
      deviceId: this.options.relayIdentity.deviceId,
      timestamp: this.now().toISOString(),
    };
  }
}

function sameDelivery(left: DeliveryFrame, right: DeliveryFrame): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deliveryTerminalStatus(
  delivery: DeliveryRecord,
): "completed" | "failed" | "canceled" | undefined {
  const { status } = delivery;
  return status === "completed" || status === "failed" || status === "canceled"
    ? status
    : undefined;
}

function deliveryMatchesFrame(delivery: DeliveryRecord, frame: DeliveryFrame): boolean {
  return delivery.deliveryId === frame.payload.deliveryId && delivery.sessionId === frame.sessionId &&
    delivery.teamId === frame.payload.teamId && delivery.idempotencyKey === frame.idempotencyKey &&
    delivery.action === frame.payload.action && delivery.sequence === frame.payload.sequence &&
    delivery.issueId === frame.payload.issueId && delivery.prompt === frame.payload.prompt;
}

function bindingMatchesFrame(binding: SessionBinding, frame: DeliveryFrame): boolean {
  return binding.linearSessionId === frame.sessionId && binding.teamId === frame.payload.teamId &&
    (frame.payload.openclawSessionId === undefined ||
      frame.payload.openclawSessionId === binding.openclawSessionId);
}

function bounded(value: string, maximum: number): string {
  return value.trim().slice(0, maximum);
}

function safeToolName(value: string | undefined): string {
  const sanitized = value?.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 256);
  return sanitized || "tool";
}

function safePhaseActivity(phase: string): string | undefined {
  if (phase === "turn_accepted") return "OpenClaw accepted the delivery.";
  if (phase === "assistant_output_started") return "Preparing the response.";
  return undefined;
}

function projectFinalResult(result: EmbeddedRunResult): { kind: "response"; text?: string } | { kind: "error" } {
  const payloads = result.payloads ?? [];
  if (payloads.some((payload) => payload.isError === true)) return { kind: "error" };
  const visible = payloads.flatMap((payload) =>
    payload.isReasoning === true || payload.isCommentary === true || typeof payload.text !== "string"
      ? []
      : [payload.text.trim()],
  ).filter(Boolean);
  const text = visible.at(-1);
  return text === undefined ? { kind: "response" } : { kind: "response", text };
}
