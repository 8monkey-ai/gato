import type { Controls } from "../conversation/controls.ts";
import type { ChatRef, TurnEnd } from "../record/types.ts";

const settled: readonly (TurnEnd | "busy")[] = ["completed", "skipped", "busy"];

export async function recordNudgeOutcome(
  controls: Pick<Controls, "note">,
  ref: ChatRef,
  outcome: TurnEnd | "busy",
) {
  if (settled.includes(outcome)) return;
  await controls.note(ref, {
    by: "system",
    kind: "nudge-failed",
    text: `Nudge failed: ${outcome}`,
  });
}
