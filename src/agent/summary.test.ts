import { describe, expect, test } from "bun:test";

import type { Entry } from "../record/chat-file.ts";
import { needsSummary, summarySource, transcript } from "./summary.ts";

const now = new Date("2026-03-31T12:00:00.000Z");
const daysAgo = (days: number) =>
  new Date(now.getTime() - days * 86_400_000).toISOString();

const entries: Entry[] = [
  { kind: "message", role: "customer", at: daysAgo(40), text: "too old" },
  { kind: "message", role: "customer", at: daysAgo(5), text: "I need a loan" },
  {
    kind: "message",
    role: "operator",
    at: daysAgo(4),
    attachments: [
      {
        kind: "image",
        source: "x",
        name: "a.jpg",
        prepared: { model: "m", text: "A form" },
      },
    ],
  },
  {
    kind: "message",
    role: "agent",
    at: daysAgo(4),
    text: "draft",
    delivery: "unsent",
  },
  { kind: "message", role: "workflow", at: daysAgo(4), text: "Welcome" },
  { kind: "note", author: "agent", at: daysAgo(3), text: "Nudge" },
  {
    kind: "message",
    role: "agent",
    at: daysAgo(3),
    text: "Sure",
    delivery: "sent",
  },
];

describe("contact summaries", () => {
  test("use dated customer, operator, and delivered agent content of the last month", () => {
    const source = summarySource(entries, now);
    expect(transcript(source, "Asia/Manila")).toBe(
      [
        "[2026-03-26 20:00] Customer: I need a loan",
        '[2026-03-27 20:00] Human colleague: [image "a.jpg": A form]',
        "[2026-03-28 20:00] Agent: Sure",
      ].join("\n"),
    );
  });

  test("follow the three-day rules", () => {
    const source = summarySource(entries, now);
    expect(needsSummary(undefined, source, now)).toBe(true);
    expect(needsSummary(undefined, source.slice(2), now)).toBe(true);
    expect(needsSummary(undefined, [], now)).toBe(false);
    expect(needsSummary({ at: daysAgo(2.9) }, source, now)).toBe(false);
    expect(needsSummary({ at: daysAgo(3) }, source, now)).toBe(true);
    expect(needsSummary({ at: daysAgo(3) }, [], now)).toBe(false);
    const recent = summarySource(
      [{ kind: "message", role: "customer", at: daysAgo(2) }],
      now,
    );
    expect(needsSummary(undefined, recent, now)).toBe(false);
  });
});
