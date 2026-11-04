import { z } from "zod";

import { chatStatus, instant, ownerKind, ownerSource } from "./events.ts";

const chatRef = z.object({
  kind: z.string().min(1),
  connection: z.string().min(1),
  chatKey: z.string().min(1),
});
/** One continuing chat. Its folder is `<dataDir>/<connection>/<chatKey>/`. */
export type ChatRef = z.infer<typeof chatRef>;

export const chatState = z.object({
  version: z.literal(1),
  appliedSeq: z.int().nonnegative(),
  chat: chatRef,
  status: chatStatus,
  statusAt: instant,
  owner: z.object({ kind: ownerKind, at: instant, source: ownerSource }),
  labels: z.array(z.string()),
  activity: z.object({
    lastCustomerAt: instant.optional(),
    lastAgentAt: instant.optional(),
    lastOperatorAt: instant.optional(),
    lastWorkflowAt: instant.optional(),
  }),
});
export type ChatState = z.infer<typeof chatState>;

/** How a chat without a record starts. The channel decides this, not the record. */
export interface ChatStart {
  status: ChatState["status"];
  owner: Omit<ChatState["owner"], "at">;
}

/** Times of 0 mark the start values as defaults, so any channel event replaces them. */
export function newChatState(chat: ChatRef, start: ChatStart): ChatState {
  return {
    version: 1,
    appliedSeq: 0,
    chat,
    status: start.status,
    statusAt: 0,
    owner: { ...start.owner, at: 0 },
    labels: [],
    activity: {},
  };
}
