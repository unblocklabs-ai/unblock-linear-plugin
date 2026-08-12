import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it, vi } from "vitest";
import {
  RECONNECT_GATEWAY_METHOD,
  ReconnectError,
  registerReconnectCli,
  registerReconnectGateway,
  runReconnectCli,
} from "../src/reconnect.js";

describe("operator reconnect surface", () => {
  it("registers a lazy root CLI descriptor", () => {
    const registerCli = vi.fn();

    registerReconnectCli({ registerCli } as unknown as OpenClawPluginApi);

    expect(registerCli).toHaveBeenCalledOnce();
    expect(registerCli.mock.calls[0]?.[1]).toMatchObject({
      commands: ["unblock-linear"],
      descriptors: [{ name: "unblock-linear", hasSubcommands: true }],
    });
  });

  it("calls only the running Gateway with empty params and operator write scope", async () => {
    const callGateway = vi.fn(async () => ({ status: "connected" }));
    const writeLine = vi.fn();

    await expect(runReconnectCli({ json: true, timeout: "1000" }, {
      callGateway,
      writeLine,
    })).resolves.toEqual({ status: "connected" });

    expect(callGateway).toHaveBeenCalledWith(
      RECONNECT_GATEWAY_METHOD,
      { json: true, timeout: "1000" },
      {},
      { scopes: ["operator.write"], progress: false },
    );
    expect(writeLine).toHaveBeenCalledWith('{"status":"connected"}');
  });

  it("registers a write-scoped Gateway handler with strict empty params", async () => {
    const registerGatewayMethod = vi.fn();
    const reconnect = vi.fn(async () => ({ status: "connected" as const }));
    registerReconnectGateway(
      { registerGatewayMethod } as unknown as OpenClawPluginApi,
      { reconnect },
    );
    const handler = registerGatewayMethod.mock.calls[0]?.[1];
    if (typeof handler !== "function") throw new Error("Expected Gateway handler");

    expect(registerGatewayMethod.mock.calls[0]?.[0]).toBe(RECONNECT_GATEWAY_METHOD);
    expect(registerGatewayMethod.mock.calls[0]?.[2]).toEqual({ scope: "operator.write" });

    const invalidRespond = vi.fn();
    await handler({ params: { unexpected: true }, respond: invalidRespond });
    expect(reconnect).not.toHaveBeenCalled();
    expect(invalidRespond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({
      code: "INVALID_REQUEST",
    }));

    const validRespond = vi.fn();
    await handler({ params: {}, respond: validRespond });
    expect(reconnect).toHaveBeenCalledOnce();
    expect(validRespond).toHaveBeenCalledWith(true, { status: "connected" });
  });

  it("returns content-free operator errors", async () => {
    const registerGatewayMethod = vi.fn();
    registerReconnectGateway(
      { registerGatewayMethod } as unknown as OpenClawPluginApi,
      {
        reconnect: async () => {
          throw new ReconnectError("device_replaced", "Update the enrollment configuration");
        },
      },
    );
    const handler = registerGatewayMethod.mock.calls[0]?.[1];
    if (typeof handler !== "function") throw new Error("Expected Gateway handler");
    const respond = vi.fn();

    await handler({ params: {}, respond });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNBLOCK_LINEAR_DEVICE_REPLACED",
      message: "Update the enrollment configuration",
    });
  });
});
