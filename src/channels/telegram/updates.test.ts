import { expect, test } from "bun:test";

import type { Update } from "grammy/types";

import { toIncoming } from "./updates.ts";

const base = {
  message_id: 7,
  date: 1_767_225_600,
  chat: { id: -42, type: "private" as const },
};

test("maps a text message to a customer message of its chat", () => {
  expect(
    toIncoming({ update_id: 1, message: { ...base, text: "Hi" } } as Update),
  ).toEqual({
    contact: "-42",
    ref: "7",
    role: "customer",
    at: new Date("2026-01-01T00:00:00.999Z"),
    text: "Hi",
    attachments: [],
  });
});

test("keeps the caption with the largest photo", () => {
  const update = {
    update_id: 2,
    message: {
      ...base,
      caption: "My receipt",
      photo: [
        { file_id: "small", file_unique_id: "s", width: 1, height: 1 },
        { file_id: "large", file_unique_id: "l", width: 9, height: 9 },
      ],
    },
  } as Update;
  expect(toIncoming(update)).toMatchObject({
    text: "My receipt",
    attachments: [{ kind: "image", source: "large" }],
  });
});

test("classifies voice notes, PDF documents, and unsupported content", () => {
  const voice = {
    file_id: "v",
    file_unique_id: "v",
    duration: 2,
    mime_type: "audio/ogg",
  };
  const pdf = {
    file_id: "d",
    file_unique_id: "d",
    mime_type: "application/pdf",
    file_name: "a.pdf",
  };
  const location = { latitude: 1, longitude: 2 };
  const kinds = [{ voice }, { document: pdf }, { location }].map(
    (extra) =>
      toIncoming({ update_id: 3, message: { ...base, ...extra } } as Update)
        ?.attachments[0],
  );
  expect(kinds).toEqual([
    { kind: "audio", source: "v", mime: "audio/ogg" },
    { kind: "document", source: "d", mime: "application/pdf", name: "a.pdf" },
    { kind: "other", source: "", name: "location" },
  ]);
});

test("ignores updates without a message", () => {
  expect(toIncoming({ update_id: 4 })).toBeUndefined();
});
