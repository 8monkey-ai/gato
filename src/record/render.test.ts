import { expect, test } from "bun:test";

import { project } from "./projection.ts";
import { renderChat } from "./render.ts";
import type { Entry } from "./types.ts";

const at = "2026-11-04T10:15:00.000Z";

const log: Entry[] = [
  {
    seq: 1,
    at,
    type: "message",
    message: {
      id: "m1",
      author: { role: "customer" },
      sentAt: "2026-11-04T10:15:00.000Z",
      text: "Hello\nthere",
      attachments: [
        {
          id: "a1",
          category: "audio",
          source: "s",
          fileName: "voice.ogg",
          file: "attachments/m1-a1.ogg",
          preparation: { model: "m", at, text: "hi" },
        },
      ],
      delivery: "observed",
    },
  },
  {
    seq: 2,
    at,
    type: "message",
    message: {
      id: "m2",
      author: { role: "agent" },
      sentAt: "2026-11-04T10:16:00.000Z",
      text: "Hi",
      attachments: [],
      delivery: "superseded",
    },
  },
  {
    seq: 3,
    at: "2026-11-04T10:17:00.000Z",
    type: "note",
    by: "system",
    kind: "nudge",
    text: "Nudge",
  },
  {
    seq: 4,
    at: "2026-11-04T10:18:00.000Z",
    type: "message",
    message: {
      id: "m3",
      author: { role: "operator" },
      sentAt: "2026-11-04T10:14:00.000Z",
      text: "Earlier",
      attachments: [],
      delivery: "observed",
    },
  },
];

test("renders a chronological transcript in the configured time zone", () => {
  expect(renderChat(project(log), "Asia/Manila")).toBe(
    [
      "[2026-11-04 18:14:00 Asia/Manila] Operator (unknown): Earlier",
      "[2026-11-04 18:15:00 Asia/Manila] Customer: Hello",
      "  there",
      "  [audio: voice.ogg -> attachments/m1-a1.ogg; transcript: hi]",
      "[2026-11-04 18:16:00 Asia/Manila] Agent (superseded, not sent): Hi",
      "[2026-11-04 18:17:00 Asia/Manila] # note (nudge, system): Nudge",
      "",
    ].join("\n"),
  );
});
