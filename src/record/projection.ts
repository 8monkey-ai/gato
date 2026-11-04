import type {
  ChatMessage,
  Entry,
  Owner,
  TurnEnd,
  TurnTrigger,
} from "./types.ts";

type EntryOf<T extends Entry["type"]> = Extract<Entry, { type: T }>;

export type RecordedMessage = ChatMessage & { seq: number; eventId?: string };

export type Turn = {
  turnId: string;
  trigger: TurnTrigger;
  inputThroughSeq: number;
  startedAt: string;
  end?: { outcome: TurnEnd; reason?: string; seq: number };
};

export type ChatView = {
  lastSeq: number;
  messages: RecordedMessage[];
  seenEventIds: Set<string>;
  messageIdByPlatformId: Map<string, string>;
  ownership?: { owner: Owner; assigneeId?: string; eventAt: string };
  open?: { open: boolean; eventAt: string };
  turns: Turn[];
  notes: EntryOf<"note">[];
  handoffs: EntryOf<"handoff">[];
  toolActivity: EntryOf<"tool-call" | "tool-result">[];
  triggers: EntryOf<"trigger">[];
  merges: EntryOf<"merge">[];
  hasPendingInput: boolean;
  latestCustomerAt?: string;
};

type State = Omit<ChatView, "messages" | "hasPendingInput"> & {
  messages: Map<string, RecordedMessage>;
};

const isNewer = (eventAt: string, current?: { eventAt: string }) =>
  current === undefined || Date.parse(eventAt) >= Date.parse(current.eventAt);

function applyMessageUpdate(state: State, e: EntryOf<"message-update">) {
  const message = state.messages.get(e.messageId);
  // A confirmed send is final; a later uncertain, failed or pending outcome comes from a slower path.
  const downgrade =
    message?.delivery === "sent" && e.delivery && e.delivery !== "sent";
  if (!message || downgrade) return;
  if (e.delivery) message.delivery = e.delivery;
  if (e.sentAt) message.sentAt = e.sentAt;
  if (e.error) message.error = e.error;
  if (e.platformId) {
    message.platformId = e.platformId;
    state.messageIdByPlatformId.set(e.platformId, message.id);
  }
}

function applyAttachmentUpdate(state: State, e: EntryOf<"attachment-update">) {
  const attachment = state.messages
    .get(e.messageId)
    ?.attachments.find((a) => a.id === e.attachmentId);
  if (!attachment) return;
  if (e.file) {
    attachment.file = e.file;
    delete attachment.retrievalError;
  }
  if (e.mediaType) attachment.mediaType = e.mediaType;
  if (e.retrievalError) attachment.retrievalError = e.retrievalError;
  if (e.preparation) attachment.preparation = e.preparation;
}

const handlers: {
  [T in Entry["type"]]: (state: State, entry: EntryOf<T>) => void;
} = {
  message: (state, { message, seq, eventId }) => {
    state.messages.set(message.id, {
      ...structuredClone(message),
      seq,
      eventId,
    });
    if (message.platformId)
      state.messageIdByPlatformId.set(message.platformId, message.id);
  },
  "message-update": applyMessageUpdate,
  "attachment-update": applyAttachmentUpdate,
  ownership: (state, { owner, assigneeId, eventAt }) => {
    if (isNewer(eventAt, state.ownership))
      state.ownership = { owner, assigneeId, eventAt };
  },
  status: (state, { open, eventAt }) => {
    if (isNewer(eventAt, state.open)) state.open = { open, eventAt };
  },
  // Labels live in labels.txt or on the channel; the entry is part of the record only.
  labels: () => {},
  "turn-start": (state, { turnId, trigger, inputThroughSeq, at }) => {
    state.turns.push({
      turnId,
      trigger,
      inputThroughSeq,
      startedAt: at,
    });
  },
  "turn-end": (state, { turnId, outcome, reason, seq }) => {
    const turn = state.turns.find((t) => t.turnId === turnId);
    if (turn) turn.end = { outcome, reason, seq };
  },
  note: (state, entry) => state.notes.push(entry),
  handoff: (state, entry) => state.handoffs.push(entry),
  "tool-call": (state, entry) => state.toolActivity.push(entry),
  "tool-result": (state, entry) => state.toolActivity.push(entry),
  trigger: (state, entry) => state.triggers.push(entry),
  merge: (state, entry) => state.merges.push(entry),
};

export function isEntryType(type: unknown): type is Entry["type"] {
  return typeof type === "string" && Object.hasOwn(handlers, type);
}

const unanswered: readonly TurnEnd[] = ["superseded", "interrupted"];

function answeredThroughSeq(turns: Turn[]): number {
  const answered = turns
    .filter((t) => t.end && !unanswered.includes(t.end.outcome))
    .sort((a, b) => (b.end?.seq ?? 0) - (a.end?.seq ?? 0));
  return answered[0]?.inputThroughSeq ?? 0;
}

function byTimeThenSeq(a: RecordedMessage, b: RecordedMessage) {
  return Date.parse(a.sentAt) - Date.parse(b.sentAt) || a.seq - b.seq;
}

function emptyState(): State {
  return {
    lastSeq: 0,
    messages: new Map(),
    seenEventIds: new Set(),
    messageIdByPlatformId: new Map(),
    turns: [],
    notes: [],
    handoffs: [],
    toolActivity: [],
    triggers: [],
    merges: [],
  };
}

export function project(entries: Entry[]): ChatView {
  const state = emptyState();
  for (const entry of entries) {
    state.lastSeq = Math.max(state.lastSeq, entry.seq);
    if (entry.eventId) state.seenEventIds.add(entry.eventId);
    (handlers[entry.type] as (state: State, entry: Entry) => void)(
      state,
      entry,
    );
  }
  const messages = [...state.messages.values()].sort(byTimeThenSeq);
  const throughSeq = answeredThroughSeq(state.turns);
  const customer = messages.filter((m) => m.author.role === "customer");
  return {
    ...state,
    messages,
    hasPendingInput: customer.some(
      (m) => m.eventId !== undefined && m.seq > throughSeq,
    ),
    latestCustomerAt: customer
      .map((m) => m.sentAt)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0],
  };
}
