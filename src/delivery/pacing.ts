import type { OutgoingPart } from "../channels/channel.ts";
import type { DeliverySettings } from "../config/settings.ts";

function words(part: OutgoingPart) {
  return "text" in part ? part.text.split(/\s+/).filter(Boolean).length : 1;
}

export function pacingDelay(settings: DeliverySettings) {
  return (part: OutgoingPart, index: number) => {
    if (settings.pacing === "fixed") return settings.pauseMs;
    if (settings.pacing === "typing")
      return index === 0 ? 0 : words(part) * settings.msPerWord;
    return 0;
  };
}
