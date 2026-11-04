import { describe, expect, test } from "bun:test";

import { pauseBefore } from "./pacing.ts";

const text = { kind: "text", text: "one two three" } as const;
const video = {
  kind: "video",
  url: "https://videos.example.com/a.mp4",
} as const;

describe("pauseBefore", () => {
  test("fixed pacing pauses before every message", () => {
    const pacing = { mode: "fixed", pauseMs: 750, perWordMs: 1000 } as const;
    expect(pauseBefore(0, text, pacing)).toBe(750);
    expect(pauseBefore(3, video, pacing)).toBe(750);
  });

  test("typing pacing sends the first message at once and paces later ones per word", () => {
    const pacing = { mode: "typing", pauseMs: 750, perWordMs: 1000 } as const;
    expect(pauseBefore(0, text, pacing)).toBe(0);
    expect(pauseBefore(1, text, pacing)).toBe(3000);
    expect(pauseBefore(2, video, pacing)).toBe(1000);
  });

  test("no pacing never waits", () => {
    const pacing = { mode: "none", pauseMs: 750, perWordMs: 1000 } as const;
    expect(pauseBefore(0, text, pacing)).toBe(0);
    expect(pauseBefore(1, text, pacing)).toBe(0);
  });
});
