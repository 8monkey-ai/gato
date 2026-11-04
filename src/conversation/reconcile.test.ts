import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChannelConnection } from "../channels/channel.ts";
import { createLogger } from "../log.ts";
import { openChatStore } from "../storage/chat-store.ts";
import { createControls } from "./controls.ts";
import type { ChatState } from "./ownership.ts";
import { createReconciler } from "./reconcile.ts";

const ref = { connectionId: "rio", chatId: "42" };
let dataDir = "";
let logged: string[] = [];
const log = createLogger({}, (line) => logged.push(line));

type Fetch = NonNullable<ChannelConnection["assignment"]>["fetchState"];

async function setup(fetchState: Fetch) {
  let clock = new Date("2026-11-04T10:00:00.000Z");
  const now = () => clock;
  const store = await openChatStore(dataDir, { timeZone: "UTC", log, now });
  await store.append(ref, [
    { type: "status", open: false, eventAt: "2026-11-04T09:00:00.000Z" },
  ]);
  const channel = {
    assignment: {
      fetchState: (chatId: string) => {
        clock = new Date("2026-11-04T10:00:05.000Z");
        return fetchState(chatId);
      },
    },
  } as ChannelConnection;
  const controls = createControls({
    store,
    connection: () => channel,
    labels: { handoff: "h", outOfScope: "o", error: "e", expired: "x" },
    log,
  });
  const reconciler = createReconciler({
    store,
    controls,
    connection: () => channel,
    log,
    now,
  });
  return { store, reconciler };
}

beforeEach(async () => {
  logged = [];
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-reconcile-"));
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

test("reconciliation records the differences at the time before the fetch and reports the change once", async () => {
  let fetches = 0;
  const { store, reconciler } = await setup(() => {
    fetches++;
    return Promise.resolve({ owner: "agent", open: true });
  });
  const changes: [ChatState, ChatState][] = [];
  const onChange = (previous: ChatState, current: ChatState) =>
    changes.push([previous, current]);
  expect(reconciler.isReconciled(ref)).toBe(false);
  expect(await reconciler.reconcile(ref, onChange)).toBe(true);
  expect(await reconciler.reconcile(ref, onChange)).toBe(true);
  expect(fetches).toBe(1);
  expect(reconciler.isReconciled(ref)).toBe(true);
  const view = await store.load(ref);
  expect([view.ownership, view.open]).toEqual([
    { owner: "agent", eventAt: "2026-11-04T10:00:00.000Z" },
    { open: true, eventAt: "2026-11-04T10:00:00.000Z" },
  ]);
  expect(changes.map(([p, c]) => [p.owner, p.open, c.owner, c.open])).toEqual([
    ["none", false, "agent", true],
  ]);
});

test("a failed fetch logs a warning and leaves the chat unreconciled", async () => {
  const { reconciler } = await setup(() => Promise.reject(new Error("down")));
  expect(await reconciler.reconcile(ref)).toBe(false);
  expect(reconciler.isReconciled(ref)).toBe(false);
  const [line] = logged.map((l) => JSON.parse(l) as Record<string, unknown>);
  expect([line?.level, line?.event]).toEqual(["warn", "reconcile.failed"]);
});
