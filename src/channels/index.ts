// Each import links one channel adapter. The adapter registers itself.
import "./respondio/respondio.ts";
import "./telegram/telegram.ts";

export { createChannels } from "./channel.ts";
