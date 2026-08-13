import {
  defineChannelPluginEntry,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { unblockLinearPlugin } from "./src/channel.js";
import {
  unblockLinearEntryConfigSchema,
  type ResolvedUnblockLinearAccount,
} from "./src/config.js";
import { setUnblockLinearRuntime } from "./src/runtime.js";
import { createIntegrationRegistration } from "./src/integration.js";

type UnblockLinearEntry = ReturnType<
  typeof defineChannelPluginEntry<ChannelPlugin<ResolvedUnblockLinearAccount>>
>;

const unblockLinearEntry: UnblockLinearEntry = defineChannelPluginEntry({
  id: "unblock-linear",
  name: "Unblock Linear",
  description: "Runs Linear AgentSession work through OpenClaw.",
  plugin: unblockLinearPlugin,
  configSchema: unblockLinearEntryConfigSchema,
  setRuntime: setUnblockLinearRuntime,
  registerFull: (api) => {
    const integration = createIntegrationRegistration(api);
    api.registerService(integration.service);
    api.registerTool(integration.toolFactory);
  },
});

export default unblockLinearEntry;
