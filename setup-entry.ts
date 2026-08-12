import {
  defineSetupPluginEntry,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { unblockLinearPlugin } from "./src/channel.js";
import type { ResolvedUnblockLinearAccount } from "./src/config.js";

const unblockLinearSetupEntry: {
  plugin: ChannelPlugin<ResolvedUnblockLinearAccount>;
} = defineSetupPluginEntry(unblockLinearPlugin);

export default unblockLinearSetupEntry;
