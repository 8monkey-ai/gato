import { afterEach, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChannelConnection } from "../channels/channel.ts";
import { type Controls, createControls } from "../conversation/controls.ts";
import type { ChatState, OwnershipPolicy } from "../conversation/ownership.ts";
import { createReconciler } from "../conversation/reconcile.ts";
import { createLogger } from "../log.ts";
import type { ChatRef, EntryBody, TurnEnd } from "../record/types.ts";
import { type ChatStore, openChatStore } from "../storage/chat-store.ts";
import { createNudgeChecker } from "./checker.ts";

const T = Date.parse("2026-11-04T10:00:00.000Z");
const minute = 60_000;
export const ref = { connectionId: "tg", chatId: "42" };
let dataDir = "";
let clock = new Date(T);
let logs: { level: string; event: string; chatId?: string }[] = [];
const log = createLogger({}, (line) => {
  logs.push(JSON.parse(line) as { level: string; event: string });
});
const nudgeSettings = {
  enabled: true,
  expiryEnabled: true,
  checkIntervalMs: 300_000,
  concurrency: 4,
  milestonesMs: [300_000, 2_100_000, 45_300_000, 45_900_000],
  hours: { startMinutes: 0, endMinutes: 1440 },
  prompt: "Nudge",
  expiryAfterMs: 49_500_000,
  expiryExemptLabel: "out-of-scope-unsolved",
};

export const logged = () => logs;

// Registers the hooks that give each test a fresh data folder and clock.
export function useCheckerFixture() {
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-checker-"));
    logs = [];
    clock = new Date(T);
  });
  afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));
}

const message = (
  id: string,
  role: "customer" | "agent",
  offsetMinutes: number,
): EntryBody => ({
  type: "message",
  message: {
    id,
    author: { role },
    sentAt: new Date(T + offsetMinutes * minute).toISOString(),
    text: id,
    attachments: [],
    delivery: role === "agent" ? "sent" : "observed",
  },
});

export function channel(
  extra: Partial<ChannelConnection> = {},
): ChannelConnection {
  return {
    id: "tg",
    maxTextLength: 4096,
    supportsVideo: false,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    send: () => Promise.resolve({ status: "sent", sentAt: new Date() }),
    fetchAttachment: () => Promise.reject(new Error("no file")),
    ...extra,
  };
}

type Options = {
  outcome?: TurnEnd | "busy";
  wrap?: (controls: Controls) => Controls;
  policy?: OwnershipPolicy;
  concurrency?: number;
  runTurn?: () => Promise<void>;
};

function fakeScheduler(store: ChatStore, options: Options) {
  const { outcome = "completed", runTurn = () => Promise.resolve() } = options;
  const runs: { chatId: string; trigger: string; nudgeNotes: number }[] = [];
  const stateChanges: string[] = [];
  const scheduler = {
    busy: () => false,
    stateChanged: (r: ChatRef, previous: ChatState, current: ChatState) =>
      stateChanges.push(`${r.chatId}:${previous.owner}->${current.owner}`),
    runExclusive: async (
      r: ChatRef,
      trigger: string,
      { beforeRun }: { beforeRun?: () => unknown } = {},
    ) => {
      if (outcome === "busy") return outcome;
      await beforeRun?.();
      const notes = (await store.load(r)).notes;
      runs.push({
        chatId: r.chatId,
        trigger,
        nudgeNotes: notes.filter((n) => n.kind === "nudge").length,
      });
      await runTurn();
      return outcome;
    },
  };
  return { scheduler, runs, stateChanges };
}

export async function setup(connection = channel(), options: Options = {}) {
  const { wrap = (c: Controls) => c } = options;
  const now = () => clock;
  const store = await openChatStore(dataDir, { timeZone: "UTC", log, now });
  const labels = { handoff: "h", outOfScope: "o", error: "e", expired: "x" };
  const controls = wrap(
    createControls({ store, connection: () => connection, labels, log }),
  );
  const fake = fakeScheduler(store, options);
  const settings = {
    ownershipPolicy: options.policy ?? "assigned",
    timeZone: "UTC",
    nudges: { ...nudgeSettings, concurrency: options.concurrency ?? 4 },
  };
  const deps = { store, controls, connection: () => connection, log, now };
  const checker = createNudgeChecker({
    ...deps,
    scheduler: fake.scheduler,
    reconciler: createReconciler(deps),
    settings,
  });
  return { store, checker, ...fake };
}

export const at = (minutes: number) => {
  clock = new Date(T + minutes * minute);
};
export const notes = async (store: ChatStore, r: ChatRef = ref) =>
  (await store.load(r)).notes.map((n) => [n.by, n.kind, n.text]);

export async function seed(r: ChatRef = ref) {
  const store = await openChatStore(dataDir, { timeZone: "UTC", log });
  await store.append(r, [message(`c-${r.chatId}`, "customer", 0)]);
  await store.append(r, [message(`a-${r.chatId}`, "agent", 6)]);
}
