import { expect, test } from "bun:test";

import type { Entry } from "./entry.ts";
import { awaitsReply, insertEntry, isAgentActivity } from "./record.ts";

const message = (
  at: string,
  role: "customer" | "agent",
  delivery?: "sent" | "failed",
): Entry => ({
  kind: "message",
  id: at,
  at,
  role,
  delivery,
});

test("inserts a delayed entry at its original place", () => {
  const entries = [message("2", "customer"), message("4", "customer")];
  insertEntry(entries, message("3", "customer"));
  expect(entries.map((entry) => entry.at)).toEqual(["2", "3", "4"]);
});

test("only sent agent messages answer the customer", () => {
  expect(
    awaitsReply([message("1", "customer"), message("2", "agent", "failed")]),
  ).toBe(true);
  expect(
    awaitsReply([message("1", "customer"), message("2", "agent", "sent")]),
  ).toBe(false);
  expect(isAgentActivity(message("1", "agent", "failed"))).toBe(false);
});
