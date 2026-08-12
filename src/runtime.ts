import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "unblock-linear",
  errorMessage: "Unblock Linear runtime not initialized",
});

export const setUnblockLinearRuntime = runtimeStore.setRuntime;
export const clearUnblockLinearRuntime = runtimeStore.clearRuntime;
export const getOptionalUnblockLinearRuntime = runtimeStore.tryGetRuntime;
export const getUnblockLinearRuntime = runtimeStore.getRuntime;
