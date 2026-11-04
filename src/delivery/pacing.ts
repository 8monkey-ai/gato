import type { OutboundPart } from "../channels/channel.ts";

export type Pacing = {
  mode: "fixed" | "typing" | "none";
  pauseMs: number;
  perWordMs: number;
};

const wordCount = (part: OutboundPart) =>
  part.kind === "video"
    ? 1
    : part.text.split(/\s+/).filter((word) => word !== "").length;

export function pauseBefore(index: number, part: OutboundPart, pacing: Pacing) {
  switch (pacing.mode) {
    case "fixed":
      return pacing.pauseMs;
    case "typing":
      return index === 0 ? 0 : wordCount(part) * pacing.perWordMs;
    case "none":
      return 0;
  }
}
