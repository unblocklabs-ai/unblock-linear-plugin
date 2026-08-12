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
import {
  registerReconnectCli,
  registerReconnectGateway,
} from "./src/reconnect.js";

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
  registerCliMetadata: registerReconnectCli,
  registerFull: (api) => {
    const integration = createIntegrationRegistration(api);
    api.registerService(integration.service);
    api.registerTool(integration.toolFactory);
    registerReconnectGateway(api, integration);
  },
});

export default unblockLinearEntry;
