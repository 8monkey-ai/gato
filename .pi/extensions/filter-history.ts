import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HISTORY_MS = (Number(process.env["GATO_HISTORY_DAYS"]) || 60) * 86_400_000;

export default function filterHistory(pi: ExtensionAPI) {
  pi.on("context", (event) => {
    return { messages: event.messages.filter((msg) => msg.timestamp >= Date.now() - HISTORY_MS) };
  });
}
