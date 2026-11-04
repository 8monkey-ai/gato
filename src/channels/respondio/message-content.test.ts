import { expect, test } from "bun:test";

import { mapPayload } from "./mapping.ts";

function contentOf(content: unknown) {
  const result = mapPayload(
    {
      event_type: "message.sent",
      event_id: "evt-1",
      contact: { id: 1 },
      message: {
        messageId: 5,
        traffic: "outgoing",
        timestamp: 1662965213,
        message: content,
      },
    },
    { agentUserId: "99", receivedAt: new Date(0) },
  );
  if (!("kind" in result) || result.kind !== "message")
    throw new Error(JSON.stringify(result));
  return { text: result.message.text, attachments: result.message.attachments };
}

test("keeps the title and replies of a quick reply", () => {
  expect(
    contentOf({
      type: "quick_reply",
      title: "Options",
      replies: ["Good", "Bad"],
    }),
  ).toEqual({ text: "Options\nGood\nBad", attachments: [] });
});

test("keeps the title, subtitle, and button texts of a card", () => {
  expect(
    contentOf({
      type: "card",
      title: "Card Title",
      subtitle: "Card subtitle",
      imageUrl: "https://abc/aaa.jpg",
      buttons: [{ text: "button text", postback: "here" }],
    }),
  ).toEqual({
    text: "Card Title\nCard subtitle\nbutton text",
    attachments: [],
  });
});

test("names a WhatsApp template and keeps its body text", () => {
  const template = {
    id: 11683712,
    name: "marketing_template",
    components: [
      { type: "header", text: "Promo" },
      { type: "body", text: "Hi John Doe\n\nWelcome to our Developer Doc." },
    ],
  };
  expect(contentOf({ type: "whatsapp_template", template })).toEqual({
    text: "[template marketing_template]\nHi John Doe\n\nWelcome to our Developer Doc.",
    attachments: [],
  });
  expect(
    contentOf({ type: "whatsapp_template", template: { name: "bye" } }).text,
  ).toBe("[template bye]");
});

test("maps a story reply to its image or video", () => {
  const story = {
    type: "image",
    url: "https://cdn.chatapi.net/stories/story_example.jpg",
    id: "story_id",
    mimeType: "image/jpeg",
    fileName: "story_example.jpg",
    size: "51200",
  };
  expect(contentOf({ type: "story_reply", story })).toEqual({
    text: "[story reply]",
    attachments: [
      {
        category: "image",
        source: "https://cdn.chatapi.net/stories/story_example.jpg",
        mediaType: "image/jpeg",
        fileName: "story_example.jpg",
        size: 51200,
      },
    ],
  });
  const video = { type: "video", url: "https://cdn.test/s.mp4" };
  expect(
    contentOf({ type: "story_reply", story: video }).attachments,
  ).toMatchObject([{ category: "video", source: "https://cdn.test/s.mp4" }]);
});

test("maps email attachments by type or media type", () => {
  const attachments = [
    { type: "file", url: "https://cdn.test/a.pdf", fileName: "a.pdf" },
    { url: "https://cdn.test/b.png", mime: "image/png" },
    { url: "https://cdn.test/c.zip", mime: "application/zip" },
    { url: "https://cdn.test/d" },
  ];
  expect(
    contentOf({
      type: "email",
      subject: "Docs",
      message: "See files",
      attachments,
    }),
  ).toMatchObject({
    text: "Docs\n\nSee files",
    attachments: [
      {
        category: "document",
        source: "https://cdn.test/a.pdf",
        fileName: "a.pdf",
      },
      {
        category: "image",
        source: "https://cdn.test/b.png",
        mediaType: "image/png",
      },
      { category: "document", source: "https://cdn.test/c.zip" },
      { category: "other", source: "https://cdn.test/d" },
    ],
  });
});
