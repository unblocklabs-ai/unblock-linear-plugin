import { readFile } from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it, vi } from "vitest";
import entry from "../index.js";
import setupEntry from "../setup-entry.js";
import { unblockLinearPlugin } from "../src/channel.js";
import {
  clearUnblockLinearRuntime,
  getOptionalUnblockLinearRuntime,
} from "../src/runtime.js";

describe("plugin entrypoints", () => {
  it("keeps setup loading registration-only", () => {
    expect(setupEntry).toEqual({ plugin: unblockLinearPlugin });
    expect(setupEntry.plugin).not.toHaveProperty("gateway");
  });

  it("registers the channel and stores the host runtime", () => {
    clearUnblockLinearRuntime();
    const registerChannel = vi.fn();
    const registerCli = vi.fn();
    const runtime = { marker: "runtime" };

    entry.register({
      registrationMode: "discovery",
      registerChannel,
      registerCli,
      runtime,
    } as unknown as OpenClawPluginApi);

    expect(registerChannel).toHaveBeenCalledOnce();
    expect(registerChannel).toHaveBeenCalledWith({ plugin: unblockLinearPlugin });
    expect(registerCli).toHaveBeenCalledOnce();
    expect(getOptionalUnblockLinearRuntime()).toBe(runtime);
    clearUnblockLinearRuntime();
  });

  it("loads only reconnect CLI metadata in cli-metadata mode", () => {
    const registerCli = vi.fn();
    const registerChannel = vi.fn();
    const registerService = vi.fn();
    const registerGatewayMethod = vi.fn();

    entry.register({
      registrationMode: "cli-metadata",
      registerCli,
      registerChannel,
      registerService,
      registerGatewayMethod,
    } as unknown as OpenClawPluginApi);

    expect(registerCli).toHaveBeenCalledOnce();
    expect(registerChannel).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
    expect(registerGatewayMethod).not.toHaveBeenCalled();
  });

  it("targets built JavaScript while compiling against the published beta", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const metadata = packageJson.openclaw as Record<string, unknown>;
    const build = metadata.build as Record<string, unknown>;
    const peerDependencies = packageJson.peerDependencies as Record<string, unknown>;
    const devDependencies = packageJson.devDependencies as Record<string, unknown>;

    expect(metadata.runtimeExtensions).toEqual(["./dist/index.js"]);
    expect(peerDependencies.openclaw).toBe(">=2026.7.2-beta.7");
    expect(devDependencies.openclaw).toBe("2026.7.2-beta.7");
    expect(build.openclawVersion).toBe("2026.7.2-beta.7");
  });

  it("keeps manifest and runtime channel identity aligned", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest.id).toBe(entry.id);
    expect(manifest.channels).toEqual([unblockLinearPlugin.id]);
    expect(manifest.activation).toMatchObject({ onStartup: true });
  });
});
