import type { Settings } from "../config/settings.ts";
import type { ChatView } from "../record/projection.ts";
import type { Owner } from "../record/types.ts";

export type OwnershipPolicy = Settings["ownershipPolicy"];
export type ChatState = { owner: Owner; open: boolean; paused: boolean };

export function chatState(
  view: ChatView,
  local: { native: boolean; paused: boolean; closed: boolean },
): { owner: Owner; open: boolean } {
  if (local.native)
    return {
      owner: view.ownership?.owner ?? "none",
      open: view.open?.open ?? true,
    };
  return { owner: local.paused ? "human" : "agent", open: !local.closed };
}

const answeringOwners: Record<OwnershipPolicy, readonly Owner[]> = {
  assigned: ["agent"],
  shared: ["agent", "none"],
  unrestricted: ["agent", "human", "none"],
};

export const sameState = (a: ChatState, b: ChatState) =>
  a.owner === b.owner && a.open === b.open && a.paused === b.paused;

// A local paused file is an operator stop, so it blocks answers under every policy.
export const mayAnswer = (state: ChatState, policy: OwnershipPolicy) =>
  state.open && !state.paused && answeringOwners[policy].includes(state.owner);
