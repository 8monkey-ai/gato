import type { OwnershipPolicy } from "../config/settings.ts";
import type { Ownership } from "./entry.ts";

const answers: Record<
  OwnershipPolicy,
  (assignee: Ownership["assignee"]) => boolean
> = {
  assigned: (assignee) => assignee === "agent",
  shared: (assignee) => assignee !== "human",
  unrestricted: () => true,
};

export function mayAnswer(policy: OwnershipPolicy, ownership: Ownership) {
  return ownership.open && answers[policy](ownership.assignee);
}
