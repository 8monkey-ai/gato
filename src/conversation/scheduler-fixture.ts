import { afterEach, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChannelConnection } from "../channels/channel.ts";
import { createLogger } from "../log.ts";
import type {
  ChatRef,
  EntryBody,
  Owner,
  TurnEnd,
  TurnTrigger,
} from "../record/types.ts";
import { type NewEntry, openChatStore } from "../storage/chat-store.ts";
import { createControls } from "./controls.ts";
import type { OwnershipPolicy } from "./ownership.ts";
import { createReconciler } from "./reconcile.ts";
import { createScheduler } from "./scheduler.ts";

let dataDir = "";
export const ref = { connectionId: "tg", chatId: "42" };
let lines: string[] = [];
export const log = createLogger({}, (line) => lines.push(line));
export const now = () => new Date("2026-11-04T10:15:00.000Z");
export const dirs = () => ({ dataDir });
export const loggedEvents = () =>
  lines.map((l) => (JSON.parse(l) as { event: string }).event);

// Registers the hooks that give each test a fresh data folder.
export function useSchedulerFixture() {
  beforeEach(async () => {
    lines = [];
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-scheduler-"));
  });
  afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));
}

export const visible = (
  id: string,
  role: "customer" | "agent",
  sentAt: string,
): EntryBody => ({
  type: "message",
  message: {
    id,
    author: { role },
    sentAt,
    text: id,
    attachments: [],
    delivery: role === "agent" ? "sent" : "observed",
  },
});

type Call = { chatId: string; trigger: TurnTrigger; signal: AbortSignal };

function fakeTurns(blockFirst: boolean) {
  const calls: Call[] = [];
  const waiters: (() => void)[] = [];
  const runTurn = (r: ChatRef, trigger: TurnTrigger, signal: AbortSignal) => {
    calls.push({ chatId: r.chatId, trigger, signal });
    waiters.splice(0).forEach((wake) => wake());
    return blockFirst && calls.length === 1
      ? new Promise<TurnEnd>((resolve) =>
          signal.addEventListener("abort", () =>
            resolve(
              signal.reason === "interrupted" ? "superseded" : "interrupted",
            ),
          ),
        )
      : Promise.resolve<TurnEnd>("completed");
  };
  const started = (count: number): Promise<void> =>
    calls.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push(resolve)).then(() =>
          started(count),
        );
  return { calls, runTurn, started };
}

type Fetch = NonNullable<ChannelConnection["assignment"]>["fetchState"];
type Options = {
  native?: boolean;
  blockFirst?: boolean;
  fetchState?: Fetch;
  policy?: OwnershipPolicy;
};

export async function setup(entries: NewEntry[], options: Options = {}) {
  const { native = false, blockFirst = true, policy = "assigned" } = options;
  const fetchState =
    options.fetchState ??
    (() => Promise.resolve({ owner: "agent", open: true }));
  const store = await openChatStore(dataDir, { timeZone: "UTC", log, now });
  if (entries.length > 0) await store.append(ref, entries);
  const channel = {
    assignment: native ? { fetchState } : undefined,
  } as ChannelConnection;
  const labels = { handoff: "h", outOfScope: "o", error: "e", expired: "x" };
  const connection = () => channel;
  const controls = createControls({ store, connection, labels, log });
  const turns = fakeTurns(blockFirst);
  const reconciler = createReconciler({
    store,
    controls,
    connection,
    log,
    now,
  });
  const scheduler = createScheduler({
    store,
    controls,
    policy,
    reconcile: reconciler.reconcile,
    runTurn: turns.runTurn,
    log,
  });
  return { store, scheduler, ...turns };
}

export const ownedByAgent: NewEntry = {
  type: "ownership",
  owner: "agent",
  eventAt: "2026-11-04T10:00:00.000Z",
};

export const state = (owner: Owner, open = true) => ({
  owner,
  open,
  paused: false,
});
