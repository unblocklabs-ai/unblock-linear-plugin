import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "openclaw/plugin-sdk/gateway-runtime";

export const RECONNECT_GATEWAY_METHOD = "unblock-linear.reconnect";

export type ReconnectResult = Readonly<{ status: "connected" }>;
export type ReconnectErrorCode = "not_revoked" | "device_replaced" | "failed" | "unavailable";

export class ReconnectError extends Error {
  constructor(readonly code: ReconnectErrorCode, message: string) {
    super(message);
    this.name = "ReconnectError";
  }
}

export type ReconnectPort = Readonly<{
  reconnect(): Promise<ReconnectResult>;
}>;

type ReconnectCliDependencies = Readonly<{
  callGateway?: typeof callGatewayFromCli;
  writeLine?: (line: string) => void;
}>;

export function registerReconnectCli(
  api: OpenClawPluginApi,
  dependencies: ReconnectCliDependencies = {},
): void {
  api.registerCli(({ program }) => {
    const root = program.command("unblock-linear").description("Manage the Unblock Linear relay");
    const command = addGatewayClientOptions(
      root.command("reconnect")
        .description("Retry a revoked Linear relay enrollment once")
        .option("--json", "Output JSON", false),
    );
    command.action(async (options: GatewayRpcOpts) => {
      await runReconnectCli(options, dependencies);
    });
  }, {
    commands: ["unblock-linear"],
    descriptors: [{
      name: "unblock-linear",
      description: "Manage the Unblock Linear relay",
      hasSubcommands: true,
      machineOutput: ({ argv }) => argv.includes("--json"),
    }],
  });
}

export function registerReconnectGateway(api: OpenClawPluginApi, port: ReconnectPort): void {
  api.registerGatewayMethod(RECONNECT_GATEWAY_METHOD, async ({ params, respond }) => {
    if (!isEmptyParams(params)) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "Reconnect does not accept parameters",
      });
      return;
    }

    try {
      respond(true, await port.reconnect());
    } catch (error) {
      if (error instanceof ReconnectError) {
        respond(false, undefined, {
          code: `UNBLOCK_LINEAR_${error.code.toUpperCase()}`,
          message: error.message,
        });
        return;
      }
      respond(false, undefined, {
        code: "UNBLOCK_LINEAR_RECONNECT_FAILED",
        message: "Unblock Linear remains revoked",
      });
    }
  }, { scope: "operator.write" });
}

export async function runReconnectCli(
  options: GatewayRpcOpts,
  dependencies: ReconnectCliDependencies = {},
): Promise<ReconnectResult> {
  const callGateway = dependencies.callGateway ?? callGatewayFromCli;
  const result = parseReconnectResult(await callGateway(
    RECONNECT_GATEWAY_METHOD,
    options,
    {},
    { scopes: ["operator.write"], progress: false },
  ));
  const writeLine = dependencies.writeLine ?? console.log;
  writeLine(options.json ? JSON.stringify(result) : "Unblock Linear reconnected.");
  return result;
}

function isEmptyParams(value: unknown): value is Record<string, never> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 0;
}

function parseReconnectResult(value: unknown): ReconnectResult {
  if (!isRecord(value) || value.status !== "connected" || Object.keys(value).length !== 1) {
    throw new Error("Gateway returned an invalid Unblock Linear reconnect response");
  }
  return { status: "connected" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
