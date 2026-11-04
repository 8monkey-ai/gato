import { expect, test } from "bun:test";

import type { Author } from "../../record/types.ts";
import type { InboundMessage } from "../channel.ts";
import { mapPayload, type MapResult } from "./mapping.ts";

const context = {
  agentUserId: "99",
  receivedAt: new Date("2026-11-04T10:00:00.000Z"),
};

const contact = {
  id: 1,
  firstName: "John",
  lastName: "Doe",
  phone: "+60123456789",
  language: "en",
  status: "open",
  assignee: { id: 2, firstName: "Jane", lastName: "Roe", email: "j@x.com" },
  created_at: 1663274081,
};

function message(
  traffic: "incoming" | "outgoing",
  content: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    event_type: traffic === "incoming" ? "message.received" : "message.sent",
    event_id: "evt-1",
    contact,
    message: {
      messageId: 1726740558441000,
      channelMessageId: "123",
      contactId: 1,
      channelId: 123,
      traffic,
      timestamp: 1726740558441,
      message: content,
      replyTo: [{ id: 1 }],
    },
    channel: { id: 1, name: "string", source: "facebook" },
    ...extra,
  };
}

const text = {
  type: "text",
  text: "Message text",
  messageTaG: "ACCOUNT_UPDATE",
};

function mapped(author: Author, rest: Partial<InboundMessage> = {}): MapResult {
  return {
    kind: "message",
    chatId: "1",
    eventId: "evt-1",
    message: {
      platformId: "1726740558441000",
      author,
      sentAt: new Date("2024-09-19T10:09:18.441Z"),
      text: "Message text",
      attachments: [],
      ...rest,
    },
  };
}

test("maps an incoming text message to customer content", () => {
  const payload = message("incoming", text, {
    sender: { source: "contact", userId: 123456789 },
  });
  expect(mapPayload(payload, context)).toEqual(mapped({ role: "customer" }));
});

test("maps an incoming image attachment and reads second timestamps", () => {
  const payload = message("incoming", {
    type: "attachment",
    attachment: {
      type: "image",
      url: "https://cdn.chatapi.net/a/f10e.jpg",
      isPending: false,
      fileName: "f10e.jpg",
      ext: "jpg",
      size: "217386",
      mime: "image/jpeg",
    },
  });
  payload.message.timestamp = 1662965213;
  expect(mapPayload(payload, context)).toEqual(
    mapped(
      { role: "customer" },
      {
        sentAt: new Date("2022-09-12T06:46:53.000Z"),
        text: undefined,
        attachments: [
          {
            category: "image",
            source: "https://cdn.chatapi.net/a/f10e.jpg",
            mediaType: "image/jpeg",
            fileName: "f10e.jpg",
            size: 217386,
          },
        ],
      },
    ),
  );
});

test("maps outgoing file attachments with a caption", () => {
  const payload = message("outgoing", {
    type: "attachment",
    attachment: {
      type: "file",
      url: "https://cdn.chatapi.net/a/doc.pdf",
      mimeType: "application/pdf",
      size: 180072,
      description: "Your invoice",
    },
  });
  expect(mapPayload(payload, context)).toMatchObject({
    message: {
      author: { role: "operator" },
      text: "Your invoice",
      attachments: [
        {
          category: "document",
          source: "https://cdn.chatapi.net/a/doc.pdf",
          mediaType: "application/pdf",
          size: 180072,
        },
      ],
    },
  });
});

test("classifies outgoing senders", () => {
  const user = { id: 2, firstName: "John", lastName: "Doe" };
  const sent = (sender: unknown) =>
    mapPayload(message("outgoing", text, { sender, user }), context);
  expect(sent({ source: "user", userId: 2, workflowId: 5 })).toEqual(
    mapped({ role: "operator", id: "2", name: "John Doe" }),
  );
  expect(sent({ source: "workflow", workflowId: 77 })).toEqual(
    mapped({ role: "workflow", id: "77" }),
  );
  expect(sent({ source: "api" })).toEqual(mapped({ role: "agent" }));
  expect(sent({ source: "user", userId: 99 })).toEqual(
    mapped({ role: "agent" }),
  );
  expect(mapPayload(message("outgoing", text), context)).toEqual(
    mapped({ role: "operator" }),
  );
});

test("maps other message types to text", () => {
  const textOf = (content: unknown) =>
    mapPayload(message("incoming", content), context);
  expect(
    textOf({ type: "email", subject: "Refund", message: "Please help" }),
  ).toMatchObject({ message: { text: "Refund\n\nPlease help" } });
  expect(
    textOf({
      type: "location",
      latitude: 3.153,
      longitude: 101.118,
      address: "KL",
    }),
  ).toMatchObject({ message: { text: "[location] KL (3.153, 101.118)" } });
  expect(textOf({ type: "custom_payload", payload: {} })).toMatchObject({
    message: { text: "[unsupported custom_payload message]" },
  });
});

test("maps assignee changes to ownership at receipt time", () => {
  const assigned = (assignee: unknown) =>
    mapPayload(
      {
        event_type: "contact.assignee.updated",
        event_id: "evt-2",
        contact: { ...contact, assignee },
      },
      context,
    );
  const base = {
    kind: "ownership" as const,
    chatId: "1",
    eventId: "evt-2",
    at: new Date("2026-11-04T10:00:00.000Z"),
  };
  expect(assigned({ id: 99, firstName: "Bot" })).toEqual({
    ...base,
    owner: "agent",
    assigneeId: "99",
  });
  expect(assigned({ id: 2 })).toEqual({
    ...base,
    owner: "human",
    assigneeId: "2",
  });
  expect(assigned(null)).toEqual({ ...base, owner: "none" });
});

test("maps conversation opened and closed to status", () => {
  expect(
    mapPayload(
      {
        event_type: "conversation.opened",
        event_id: "evt-3",
        contact,
        conversation: { source: "api", conversationOpenedAt: 1663274081 },
      },
      context,
    ),
  ).toEqual({
    kind: "status",
    chatId: "1",
    eventId: "evt-3",
    at: new Date("2022-09-15T20:34:41.000Z"),
    open: true,
  });
  expect(
    mapPayload(
      {
        event_type: "conversation.closed",
        event_id: "evt-4",
        contact,
        conversation: { closedTime: 1663274099000, closedBy: {} },
      },
      context,
    ),
  ).toEqual({
    kind: "status",
    chatId: "1",
    eventId: "evt-4",
    at: new Date("2022-09-15T20:34:59.000Z"),
    open: false,
  });
});

test("ignores other event types and reports malformed payloads", () => {
  expect(
    mapPayload({ event_type: "comment.created", contact, text: "x" }, context),
  ).toEqual({ ignore: "event type comment.created is not handled" });
  expect(mapPayload([1], context)).toEqual({
    malformed: "event_type is missing",
  });
  expect(
    mapPayload({ event_type: "message.received", contact }, context),
  ).toEqual({ malformed: "event_id: invalid_type; message: invalid_type" });
  expect(
    mapPayload(message("incoming", { type: "attachment" }), context),
  ).toEqual({ malformed: "empty attachment message" });
});
