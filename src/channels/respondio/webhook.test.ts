import { describe, expect, test } from "bun:test";

import { parseNotification } from "./webhook.ts";

const message = (
  traffic: string,
  extra: object = {},
  content: object = { type: "text", text: "Hi" },
) =>
  JSON.stringify({
    event_type: traffic === "incoming" ? "message.received" : "message.sent",
    contact: { id: 5 },
    message: {
      messageId: 9,
      traffic,
      timestamp: 1_767_225_600,
      message: content,
    },
    ...extra,
  });

const roleOf = (body: string) => {
  const parsed = parseNotification(body, 77);
  return parsed.kind === "message"
    ? [parsed.message.role, parsed.message.sender]
    : parsed.kind;
};

describe("respond.io message notifications", () => {
  test("classify senders in the specified order", () => {
    expect(roleOf(message("incoming"))).toEqual(["customer", undefined]);
    expect(
      roleOf(message("outgoing", { sender: { source: "workflow" } })),
    ).toEqual(["workflow", undefined]);
    expect(roleOf(message("outgoing", { sender: { source: "api" } }))).toEqual([
      "agent",
      undefined,
    ]);
    expect(
      roleOf(message("outgoing", { sender: { source: "user", userId: 77 } })),
    ).toEqual(["agent", undefined]);
    expect(
      roleOf(message("outgoing", { sender: { source: "user", userId: 3 } })),
    ).toEqual(["operator", "user:3"]);
    expect(roleOf(message("outgoing"))).toEqual(["operator", "unknown"]);
  });
});

describe("respond.io message content", () => {
  test("keep attachments, captions, and seconds-based times", () => {
    const parsed = parseNotification(
      message(
        "outgoing",
        {},
        {
          type: "attachment",
          attachment: {
            type: "file",
            url: "https://cdn.test/a.pdf",
            fileName: "a.pdf",
            caption: "Form",
          },
        },
      ),
      undefined,
    );
    expect(parsed).toMatchObject({
      kind: "message",
      message: {
        contact: "5",
        ref: "9",
        at: new Date("2026-01-01T00:00:00.999Z"),
        text: "Form",
        attachments: [
          { kind: "document", source: "https://cdn.test/a.pdf", name: "a.pdf" },
        ],
      },
    });
  });
});

describe("respond.io missing values", () => {
  test("accept null for values that respond.io does not have", () => {
    const incoming = message("incoming", {
      sender: { source: "contact", userId: null },
    });
    expect(roleOf(incoming)).toEqual(["customer", undefined]);
    const outgoing = message(
      "outgoing",
      { sender: { source: "user", userId: null } },
      {
        type: "attachment",
        text: null,
        attachment: {
          type: "image",
          url: "https://cdn.test/a.jpg",
          fileName: null,
          mime: null,
        },
      },
    );
    expect(roleOf(outgoing)).toEqual(["operator", "unknown"]);
    expect(parseNotification(outgoing, undefined)).toMatchObject({
      message: {
        attachments: [{ kind: "image", source: "https://cdn.test/a.jpg" }],
      },
    });
  });

  test("ignore other events and report malformed ones", () => {
    expect(
      parseNotification('{"event_type":"contact.updated"}', undefined).kind,
    ).toBe("ignored");
    expect(
      parseNotification('{"event_type":"message.received"}', undefined).kind,
    ).toBe("malformed");
    expect(parseNotification("not json", undefined).kind).toBe("malformed");
  });
});
