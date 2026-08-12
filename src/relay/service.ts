import {
  createSignedDeviceUpgrade,
  type DeviceAuthDependencies,
  type DeviceAuthUpgradeInput,
  type SignedDeviceUpgrade,
} from "./device-auth.js";
import {
  parseInboundRelayFrame,
  parseOutboundRelayFrame,
  RelayProtocolError,
  type InboundRelayFrame,
  type OutboundRelayFrame,
} from "./protocol.js";
import {
  type RelayJournal,
  type ReplayEntry,
  type ReplayEntryInput,
} from "./journal.js";
import { acquireRelayWriterLease, type RelayWriterLease } from "./lease.js";

export type RelayServiceState =
  | "starting"
  | "connected"
  | "reconnect_wait"
  | "revoked"
  | "device_replaced"
  | "stopped";

export type RelaySocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Last-resort transport teardown for shutdown only when graceful close stalls. */
  terminate?(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: string | ArrayBuffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number, reason: string | Buffer) => void): unknown;
  on(
    event: "unexpected-response",
    listener: (response: RelayUnexpectedResponse) => Promise<void> | void,
  ): unknown;
};

export type RelayUnexpectedResponse = Readonly<{
  statusCode: number;
  body?: string;
}>;

export type RelaySocketFactory = (upgrade: SignedDeviceUpgrade) => RelaySocket;

export type RelayTimer = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type RelayServiceCallbacks = {
  onDelivery?(frame: Extract<InboundRelayFrame, { type: "delivery" }>): Promise<void> | void;
  onRpcResult?(frame: Extract<InboundRelayFrame, { type: "rpc.result" }>, replay?: ReplayEntry): Promise<void> | void;
  onDeliveryAcknowledged?(frame: Extract<InboundRelayFrame, { type: "delivery.ack" }>): Promise<void> | void;
  onSessionStop?(sessionId: string | undefined, reason: string | undefined): Promise<void> | void;
  onTeamAccessRemoved?(teamId: string): Promise<void> | void;
  onInstallationRevoked?(): Promise<void> | void;
  onDeviceReplaced?(generation: number): Promise<void> | void;
  onTerminal?(reason: "revoked" | "device_replaced"): Promise<void> | void;
  onStateChange?(state: RelayServiceState): void;
};

export type RelayServiceOptions = {
  account: DeviceAuthUpgradeInput;
  journal: RelayJournal;
  leasePath: string;
  socketFactory: RelaySocketFactory;
  callbacks?: RelayServiceCallbacks;
  auth?: DeviceAuthDependencies;
  timers?: RelayTimer;
  random?: () => number;
  acquireLease?: (path: string) => Promise<RelayWriterLease>;
  reconnect?: {
    initialDelayMs?: number;
    maximumDelayMs?: number;
  };
};

export type RelayStartOptions = {
  oneShot?: boolean;
  /** Resolve only after the initial socket either opens or closes before opening. */
  awaitOpen?: boolean;
};

export class RelayServiceError extends Error {
  constructor(readonly code: "not_connected" | "terminal" | "stopped") {
    super(`Relay service is ${code.replaceAll("_", " ")}`);
    this.name = "RelayServiceError";
  }
}

const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAXIMUM_RECONNECT_DELAY_MS = 30_000;
const STOP_CLOSE_GRACE_MS = 250;

export class RelayService {
  private readonly callbacks: RelayServiceCallbacks;
  private readonly timer: RelayTimer;
  private readonly random: () => number;
  private readonly acquireLease: (path: string) => Promise<RelayWriterLease>;
  private readonly initialReconnectDelayMs: number;
  private readonly maximumReconnectDelayMs: number;
  private state: RelayServiceState = "stopped";
  private lease: RelayWriterLease | undefined;
  private socket: RelaySocket | undefined;
  private reconnectTimer: unknown;
  private reconnectAttempt = 0;
  private oneShot = false;
  private probingRevoked = false;
  private inbound = Promise.resolve();
  private closeWaiter: Promise<void> | undefined;
  private resolveClose: (() => void) | undefined;
  private opening: { socket: RelaySocket; resolve: (opened: boolean) => void } | undefined;
  private readonly deliveryTasks = new Set<Promise<void>>();

  constructor(private readonly options: RelayServiceOptions) {
    this.callbacks = options.callbacks ?? {};
    this.timer = options.timers ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.random = options.random ?? Math.random;
    this.acquireLease = options.acquireLease ?? acquireRelayWriterLease;
    this.initialReconnectDelayMs = options.reconnect?.initialDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS;
    this.maximumReconnectDelayMs = options.reconnect?.maximumDelayMs ?? DEFAULT_MAXIMUM_RECONNECT_DELAY_MS;
    if (
      !Number.isSafeInteger(this.initialReconnectDelayMs) || this.initialReconnectDelayMs < 1 ||
      !Number.isSafeInteger(this.maximumReconnectDelayMs) || this.maximumReconnectDelayMs < this.initialReconnectDelayMs
    ) {
      throw new Error("Invalid relay reconnect timing");
    }
  }

  getState(): RelayServiceState {
    return this.state;
  }

  async start(startOptions: RelayStartOptions = {}): Promise<boolean> {
    if (this.state !== "stopped") return false;
    const fence = this.options.journal.getLifecycle();
    if (fence.fence === "device_replaced") {
      this.setState("device_replaced");
      return false;
    }

    this.oneShot = startOptions.oneShot === true;
    const probingRevoked = fence.fence === "revoked";
    this.probingRevoked = probingRevoked;
    this.setState("starting");
    try {
      this.lease = await this.acquireLease(this.options.leasePath);
    } catch (error) {
      this.setState("stopped");
      throw error;
    }
    const opening = this.connect();
    if (opening === undefined) {
      if (probingRevoked) {
        this.setState("revoked");
        await this.releaseLease();
      } else if (this.oneShot) {
        await this.releaseLeaseAndStop();
      }
      return !probingRevoked && !this.oneShot && this.getState() === "reconnect_wait";
    }
    if (!probingRevoked && startOptions.awaitOpen !== true) return true;

    const opened = await opening;
    if (!opened) {
      if (probingRevoked && this.getState() !== "device_replaced") {
        this.setState("revoked");
        await this.releaseLease();
      }
      return false;
    }
    if (!probingRevoked) return true;
    if (this.getState() !== "connected" || !this.probingRevoked) return false;
    await this.options.journal.setLifecycle("normal");
    this.probingRevoked = false;
    await this.replayUnresolved();
    return this.getState() === "connected";
  }

  async stop(): Promise<void> {
    this.clearReconnectTimer();
    this.setState("stopped");
    const socket = this.socket;
    if (socket !== undefined) {
      const closeWaiter = this.closeWaiter;
      socket.close(1000, "Relay service stopped");
      if (closeWaiter !== undefined && !await this.waitForGracefulClose(closeWaiter)) {
        try {
          socket.terminate?.();
        } finally {
          this.abandonSocket(socket);
        }
      }
    }
    await this.releaseLease();
  }

  async send(frame: OutboundRelayFrame): Promise<void> {
    if (this.state === "revoked" || this.state === "device_replaced") throw new RelayServiceError("terminal");
    if (this.state === "stopped") throw new RelayServiceError("stopped");
    const encoded = JSON.stringify(frame);
    const validated = parseOutboundRelayFrame(encoded);
    if (!this.sendEncoded(JSON.stringify(validated))) throw new RelayServiceError("not_connected");
  }

  async sendRpc(frame: Extract<OutboundRelayFrame, { type: "rpc.request" }>, deliveryId?: string): Promise<boolean> {
    return this.persistAndSend({
      key: `rpc:${frame.correlationId}`,
      kind: "rpc",
      ...(deliveryId === undefined ? {} : { deliveryId }),
      frame,
    });
  }

  async sendActivity(
    frame: Extract<OutboundRelayFrame, { type: "activity" }>,
    deliveryId: string,
  ): Promise<boolean> {
    return this.persistAndSend({ key: `activity:${frame.payload.commandId}`, kind: "activity", deliveryId, frame });
  }

  async sendDeliveryStatus(frame: Extract<OutboundRelayFrame, { type: "delivery.status" }>): Promise<boolean> {
    return this.persistAndSend({ key: `delivery-status:${frame.payload.deliveryId}:${frame.payload.status}`, kind: "delivery_status", frame });
  }

  private async persistAndSend(entry: ReplayEntryInput): Promise<boolean> {
    if (this.state === "revoked" || this.state === "device_replaced") throw new RelayServiceError("terminal");
    if (this.state === "stopped") throw new RelayServiceError("stopped");
    const persisted = await this.options.journal.addReplay(entry);
    return this.sendEncoded(JSON.stringify(persisted.frame));
  }

  private connect(): Promise<boolean> | undefined {
    if (this.socket !== undefined || this.state === "revoked" || this.state === "device_replaced" || this.state === "stopped") {
      return undefined;
    }
    let socket: RelaySocket;
    try {
      socket = this.options.socketFactory(createSignedDeviceUpgrade(this.options.account, this.options.auth));
    } catch {
      if (!this.probingRevoked) this.scheduleReconnect();
      return undefined;
    }
    this.socket = socket;
    this.closeWaiter = new Promise<void>((resolve) => {
      this.resolveClose = resolve;
    });
    const opened = new Promise<boolean>((resolve) => {
      this.opening = { socket, resolve };
    });
    socket.on("open", () => {
      void this.handleOpen(socket);
    });
    socket.on("message", (data) => this.enqueueInbound(socket, data));
    socket.on("error", () => undefined);
    socket.on("close", (code) => {
      void this.handleClose(socket, code);
    });
    socket.on("unexpected-response", (response) => this.handleUnexpectedResponse(socket, response));
    return opened;
  }

  private async handleUnexpectedResponse(
    socket: RelaySocket,
    response: RelayUnexpectedResponse,
  ): Promise<void> {
    if (socket !== this.socket || this.isTerminalOrStopped()) return;
    if (response.statusCode === 409 && isDeviceReplacedResponse(response.body)) {
      await this.transitionTerminal("device_replaced", this.options.account.enrollmentGeneration);
    }
  }

  private async handleOpen(socket: RelaySocket): Promise<void> {
    if (socket !== this.socket || this.isTerminalOrStopped()) return;
    this.reconnectAttempt = 0;
    this.setState("connected");
    this.settleOpening(socket, true);
    if (!this.probingRevoked) await this.replayUnresolved();
  }

  private enqueueInbound(socket: RelaySocket, data: string | ArrayBuffer): void {
    this.inbound = this.inbound.then(
      () => this.handleInbound(socket, data),
      () => this.handleInbound(socket, data),
    ).catch(() => {
      if (socket === this.socket) socket.close(1011, "Relay frame processing failed");
    });
  }

  private async handleInbound(socket: RelaySocket, data: string | ArrayBuffer): Promise<void> {
    if (socket !== this.socket || this.isTerminalOrStopped()) return;
    let frame: InboundRelayFrame;
    try {
      frame = parseInboundRelayFrame(data);
    } catch (error) {
      socket.close(error instanceof RelayProtocolError && error.code === "frame_too_large" ? 1009 : 1008, "Invalid relay frame");
      return;
    }
    if (frame.agentId !== this.options.account.agentId || frame.deviceId !== this.options.account.deviceId) {
      socket.close(1008, "Relay identity mismatch");
      return;
    }

    if (frame.type === "control") {
      await this.handleControl(socket, frame);
      return;
    }
    if (frame.type === "delivery.ack") {
      await this.options.journal.acknowledgeDeliveryStatus(frame);
      await this.callbacks.onDeliveryAcknowledged?.(frame);
      return;
    }
    if (frame.type === "rpc.result") {
      const replay = this.options.journal.getReplayEntries().find((entry) =>
        entry.kind === "rpc" && entry.frame.type === "rpc.request" && entry.frame.correlationId === frame.correlationId,
      );
      await this.callbacks.onRpcResult?.(frame, replay);
      return;
    }
    this.dispatchDelivery(socket, frame);
  }

  private async handleControl(socket: RelaySocket, frame: Extract<InboundRelayFrame, { type: "control" }>): Promise<void> {
    switch (frame.payload.kind) {
      case "session.stop":
        if (frame.sessionId !== undefined) await this.options.journal.removeCanceledSessionRpcs(frame.sessionId);
        await this.callbacks.onSessionStop?.(frame.sessionId, frame.payload.reason);
        return;
      case "team.access_removed":
        await this.callbacks.onTeamAccessRemoved?.(frame.payload.teamId);
        return;
      case "installation.revoked":
        await this.transitionTerminal("revoked");
        socket.close(4003, "Installation revoked");
        return;
      case "device.replaced": {
        const generation = frame.payload.generation || this.options.account.enrollmentGeneration;
        await this.transitionTerminal("device_replaced", generation);
        socket.close(4001, "Device replaced");
        return;
      }
    }
  }

  private async handleClose(socket: RelaySocket, code: number): Promise<void> {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.resolveClose?.();
    this.resolveClose = undefined;
    this.closeWaiter = undefined;
    try {
      if (this.state === "stopped") return;
      if (this.state === "revoked" || this.state === "device_replaced") {
        await this.releaseLease();
        return;
      }
      if (code === 4003) {
        await this.transitionTerminal("revoked");
        await this.releaseLease();
        return;
      }
      if (this.probingRevoked) {
        this.setState("revoked");
        await this.releaseLease();
        return;
      }
      if (this.oneShot) {
        await this.releaseLeaseAndStop();
        return;
      }
      this.scheduleReconnect();
    } finally {
      // A probe caller may reopen this journal as soon as start() returns false.
      // Finish any terminal persistence and callbacks before resolving its opening wait.
      this.settleOpening(socket, false);
    }
  }

  private scheduleReconnect(): void {
    if (this.oneShot || this.isTerminalOrStopped() || this.reconnectTimer !== undefined) return;
    const exponent = Math.min(this.reconnectAttempt, 30);
    const ceiling = Math.min(this.maximumReconnectDelayMs, this.initialReconnectDelayMs * 2 ** exponent);
    const jitter = 0.75 + Math.min(1, Math.max(0, this.random())) * 0.5;
    const delayMs = Math.max(1, Math.floor(ceiling * jitter));
    this.reconnectAttempt += 1;
    this.setState("reconnect_wait");
    this.reconnectTimer = this.timer.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delayMs);
  }

  private sendEncoded(encoded: string): boolean {
    if (this.state !== "connected" || this.socket === undefined) return false;
    try {
      this.socket.send(encoded);
      return true;
    } catch {
      this.socket.close(1011, "Relay send failed");
      return false;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return;
    this.timer.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private isTerminalOrStopped(): boolean {
    return this.state === "stopped" || this.state === "revoked" || this.state === "device_replaced";
  }

  private setState(state: RelayServiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private async releaseLeaseAndStop(): Promise<void> {
    this.setState("stopped");
    await this.releaseLease();
  }

  private async releaseLease(): Promise<void> {
    const lease = this.lease;
    this.lease = undefined;
    if (lease !== undefined) await lease.release();
  }

  private async replayUnresolved(): Promise<void> {
    try {
      for (const entry of this.options.journal.getReplayEntries().sort((left, right) => left.sequence - right.sequence)) {
        if (!this.sendEncoded(JSON.stringify(entry.frame))) throw new RelayServiceError("not_connected");
      }
    } catch {
      this.socket?.close(1011, "Relay replay failed");
    }
  }

  private dispatchDelivery(socket: RelaySocket, frame: Extract<InboundRelayFrame, { type: "delivery" }>): void {
    try {
      const callback = this.callbacks.onDelivery?.(frame);
      if (callback === undefined) return;
      const task = Promise.resolve(callback).catch(() => {
        if (socket === this.socket && !this.isTerminalOrStopped()) {
          socket.close(1011, "Relay delivery processing failed");
        }
      });
      this.deliveryTasks.add(task);
      void task.finally(() => this.deliveryTasks.delete(task));
    } catch {
      socket.close(1011, "Relay delivery processing failed");
    }
  }

  private settleOpening(socket: RelaySocket, opened: boolean): void {
    if (this.opening?.socket !== socket) return;
    const opening = this.opening;
    this.opening = undefined;
    opening.resolve(opened);
  }

  private waitForGracefulClose(closeWaiter: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (closed: boolean) => {
        if (settled) return;
        settled = true;
        this.timer.clearTimeout(timeout);
        resolve(closed);
      };
      const timeout = this.timer.setTimeout(() => finish(false), STOP_CLOSE_GRACE_MS);
      void closeWaiter.then(() => finish(true));
    });
  }

  private abandonSocket(socket: RelaySocket): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.resolveClose?.();
    this.resolveClose = undefined;
    this.closeWaiter = undefined;
    this.settleOpening(socket, false);
  }

  private async transitionTerminal(reason: "revoked" | "device_replaced", generation?: number): Promise<void> {
    await this.options.journal.setLifecycle(reason, generation);
    this.probingRevoked = false;
    this.setState(reason);
    if (reason === "revoked") {
      await this.callbacks.onInstallationRevoked?.();
    } else {
      await this.callbacks.onDeviceReplaced?.(generation ?? this.options.account.enrollmentGeneration);
    }
    await this.callbacks.onTerminal?.(reason);
  }
}

function isDeviceReplacedResponse(body: string | undefined): boolean {
  if (body === undefined) return false;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 1 && entries[0]?.[0] === "error" &&
    entries[0][1] === "device_replaced";
}
