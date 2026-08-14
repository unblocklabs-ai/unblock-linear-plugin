import {
  defineSetupPluginEntry,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { unblockLinearPlugin } from "./src/channel.js";
import type { ResolvedUnblockLinearAccount } from "./src/config.js";

const { gateway: _runtimeGateway, ...setupPlugin } = unblockLinearPlugin;

const unblockLinearSetupEntry: {
  plugin: ChannelPlugin<ResolvedUnblockLinearAccount>;
} = defineSetupPluginEntry(setupPlugin);

export default unblockLinearSetupEntry;
