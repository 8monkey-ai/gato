import { describe, expect, test } from "bun:test";

import { parseChat, serializeChat } from "./chat-file.ts";

const sample = `[2026-01-05T10:00:00.000Z] customer {"ref":"m1","attachments":[{"kind":"image","source":"https://x.test/a.jpg","file":"attachments/a.jpg"}]}
  Hello
  
  second line

[2026-01-05T10:00:05.000Z] agent {"ref":"m2","delivery":"sent","turn":"t1"}
  Hi! [link](https://x.test)

[2026-01-05T10:00:06.000Z] turn {"turn":"t1","trigger":"customer","outcome":"completed","started":"2026-01-05T10:00:01.000Z"}

[2026-01-05T10:05:00.000Z] note {"author":"agent"}
  Nudge
`;

describe("chat.txt format", () => {
  test("reads entries with their text and attributes", () => {
    const { entries, damaged } = parseChat(sample);
    expect(damaged).toBe(0);
    expect(entries.map((e) => e.kind)).toEqual([
      "message",
      "message",
      "turn",
      "note",
    ]);
    expect(entries[0]).toMatchObject({
      role: "customer",
      text: "Hello\n\nsecond line",
      attachments: [{ kind: "image", file: "attachments/a.jpg" }],
    });
    expect(entries[1]).toMatchObject({
      role: "agent",
      delivery: "sent",
      text: "Hi! [link](https://x.test)",
    });
  });

  test("writes the same text it reads", () => {
    expect(serializeChat(parseChat(sample).entries)).toBe(sample);
  });

  test("normalizes times with an offset to UTC", () => {
    const { entries } = parseChat(
      "[2026-01-05T18:00:00+08:00] customer\n  Hi\n",
    );
    expect(entries[0]?.at).toBe("2026-01-05T10:00:00.000Z");
  });

  test("keeps damaged blocks unchanged and counts them", () => {
    const content = `[2026-01-05T10:00:00.000Z] customer\n  Hi\n\n[bad header\n  ???\n\n[2026-01-05T10:01:00.000Z] wizard {}\n`;
    const { entries, damaged } = parseChat(content);
    expect(damaged).toBe(2);
    expect(serializeChat(entries)).toBe(content);
  });
});
