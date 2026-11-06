import { expect, test } from "bun:test";

import { parseChat, serializeChat } from "./chat-file.ts";
import type { Entry } from "./entries.ts";

const entries: Entry[] = [
  {
    type: "message",
    id: "m1",
    at: "2026-01-01T10:00:00.000Z",
    role: "customer",
    sender: "Ali {x}",
    text: "Hello\n\n> quoted\n",
    trigger: true,
  },
  {
    type: "turn",
    id: "t1",
    at: "2026-01-01T10:00:01.000Z",
    trigger: "customer",
    status: "completed",
    covers: ["m1"],
  },
  {
    type: "note",
    id: "n1",
    at: "2026-01-01T10:00:02.000Z",
    author: "agent",
    kind: "nudge",
    text: "Nudge",
  },
  {
    type: "message",
    id: "m2",
    at: "2026-01-01T10:00:03.000Z",
    role: "agent",
    text: "",
    delivery: "sent",
  },
];

test("a chat survives a write and a read unchanged", () => {
  expect(parseChat(serializeChat(entries))).toEqual(entries);
});

test("the file is readable: one header line per entry and text lines after it", () => {
  const text = serializeChat(entries.slice(0, 1));
  expect(text.split("\n")[0]).toStartWith(
    "[2026-01-01T10:00:00.000Z] customer Ali  x  {",
  );
  expect(text.split("\n").slice(1)).toEqual([
    "> Hello",
    "> ",
    "> > quoted",
    "> ",
    "",
  ]);
});

test("damaged content is reported with its line", () => {
  expect(() => parseChat("> text without header\n")).toThrow("line 1");
  expect(() =>
    parseChat('[2026-01-01T10:00:00Z] x {"type":"unknown","id":"a"}\n'),
  ).toThrow("line 1: invalid entry metadata");
  expect(() => parseChat('[yesterday] x {"type":"note","id":"a"}\n')).toThrow(
    'invalid time "yesterday"',
  );
});
