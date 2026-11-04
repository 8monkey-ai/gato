import { expect, test } from "bun:test";

import { PreparationError } from "../attachments/prepare.ts";
import type { RecordedMessage } from "../record/projection.ts";
import type { Attachment, Author } from "../record/types.ts";
import type { HistoryItem } from "./history.ts";
import { toModelMessages } from "./model-messages.ts";

const item = (
  author: Author,
  text?: string,
  attachments: Attachment[] = [],
): HistoryItem => ({
  kind: "message",
  message: {
    id: "m",
    seq: 1,
    author,
    sentAt: "2026-11-04T10:00:00.000Z",
    text,
    attachments,
    delivery: "observed",
  } satisfies RecordedMessage,
});

const options = {
  loadFile: (relative: string) =>
    Promise.resolve(new TextEncoder().encode(relative)),
  preparedCategories: new Set(["audio" as const]),
};

test("marks operator and workflow attribution on assistant messages", async () => {
  const messages = await toModelMessages(
    [
      item({ role: "customer" }, "Hi"),
      item({ role: "operator", id: "u1", name: "Ana" }, "On it"),
      item({ role: "operator", id: "u2" }, "Checking"),
      item({ role: "operator" }, "Hello"),
      item({ role: "workflow", id: "w" }, "Welcome"),
      item({ role: "agent" }, "Sure"),
    ],
    options,
  );
  expect(messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Hi" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "[Human colleague Ana] On it" }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "[Human colleague] Checking" }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "[Human colleague (unidentified)] Hello" },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "[Workflow] Welcome" }],
    },
    { role: "assistant", content: [{ type: "text", text: "Sure" }] },
  ]);
});

const mixedAttachments: Attachment[] = [
  {
    id: "a1",
    category: "image",
    source: "s",
    file: "attachments/a1.jpg",
    fileName: "p.jpg",
  },
  {
    id: "a2",
    category: "audio",
    source: "s",
    file: "attachments/a2.ogg",
    fileName: "v.ogg",
    preparation: {
      model: "t",
      at: "2026-11-04T10:01:00.000Z",
      text: "refund please",
    },
  },
  {
    id: "a3",
    category: "video",
    source: "s",
    file: "attachments/a3.mp4",
    fileName: "c.mp4",
  },
  {
    id: "a4",
    category: "document",
    source: "s",
    fileName: "d.pdf",
    retrievalError: "gone",
  },
];

test("sends unprepared files directly and prepared ones as text", async () => {
  const messages = await toModelMessages(
    [item({ role: "customer" }, "See", mixedAttachments)],
    options,
  );
  expect(messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "See" },
        {
          type: "file",
          data: new TextEncoder().encode("attachments/a1.jpg"),
          mediaType: "image",
          filename: "p.jpg",
        },
        { type: "text", text: "[audio transcript v.ogg: refund please]" },
        {
          type: "text",
          text: "[video attachment c.mp4: not supported, content unknown]",
        },
        {
          type: "text",
          text: "[document attachment d.pdf: could not be retrieved]",
        },
      ],
    },
  ]);
});

test("a prepared operator attachment keeps the operator role", async () => {
  const messages = await toModelMessages(
    [
      item({ role: "operator", name: "Ana" }, undefined, [
        mixedAttachments[1] as Attachment,
      ]),
    ],
    options,
  );
  expect(messages).toEqual([
    {
      role: "assistant",
      content: [
        { type: "text", text: "[Human colleague Ana]" },
        { type: "text", text: "[audio transcript v.ogg: refund please]" },
      ],
    },
  ]);
});

test.each<Author>([{ role: "operator", name: "Ana" }, { role: "workflow" }])(
  "a stored %p file without a preparation model fails instead of being dropped",
  async (author) => {
    const document: Attachment = {
      id: "a1",
      category: "document",
      source: "s",
      file: "attachments/a1",
      fileName: "d.pdf",
    };
    const error = await toModelMessages(
      [item(author, "See", [document])],
      options,
    ).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(PreparationError);
    expect((error as Error).message).toBe(
      "Preparation of document attachment d.pdf failed: main model cannot take document files from colleagues; configure GATO_DOCUMENT_MODEL",
    );
  },
);

const base = {
  turnId: "t1",
  callId: "k1",
  name: "read_skill",
  seq: 2,
  at: "2026-11-04T10:00:00.000Z",
};
const toolItems: HistoryItem[] = [
  {
    kind: "tool",
    call: { type: "tool-call", ...base, input: { name: "x" } },
    result: {
      type: "tool-result",
      ...base,
      output: "missing",
      isError: true,
    },
  },
  {
    kind: "trigger",
    trigger: {
      type: "trigger",
      turnId: "t1",
      text: "Nudge",
      seq: 3,
      at: base.at,
    },
  },
];

test("renders tool pairs and internal triggers", async () => {
  const messages = await toModelMessages(toolItems, options);
  expect(messages).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "k1",
          toolName: "read_skill",
          input: { name: "x" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "k1",
          toolName: "read_skill",
          output: { type: "error-text", value: "missing" },
        },
      ],
    },
    {
      role: "user",
      content: "[Internal trigger, not from the customer] Nudge",
    },
  ]);
});
