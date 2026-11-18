import { expect, test } from "bun:test";

import type { Entry } from "../record/chat-file.ts";
import { latestMonth } from "./history.ts";

const note = (at: string): Entry => ({ kind: "note", author: "agent", at });
const kept = (entries: Entry[], now: string, timeZone: string) =>
  latestMonth(entries, new Date(now), timeZone).map((e) => e.at);

test("the latest month starts one calendar month earlier in the timezone", () => {
  const entries = [
    note("2026-02-27T19:59:59.999Z"),
    note("2026-02-27T20:00:00.000Z"),
    note("2026-02-28T20:00:00.000Z"),
  ];
  const now = "2026-03-30T20:00:00.000Z";
  expect(kept(entries, now, "Asia/Kuala_Lumpur")).toEqual([
    "2026-02-27T20:00:00.000Z",
    "2026-02-28T20:00:00.000Z",
  ]);
  expect(kept(entries, now, "UTC")).toEqual(["2026-02-28T20:00:00.000Z"]);
});

test("the latest month keeps the local time across a daylight saving change", () => {
  const entries = [
    note("2026-03-15T12:59:59.999Z"),
    note("2026-03-15T13:00:00.000Z"),
  ];
  expect(kept(entries, "2026-04-15T12:00:00.000Z", "Europe/Berlin")).toEqual([
    "2026-03-15T13:00:00.000Z",
  ]);
});
