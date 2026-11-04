import { describe, expect, test } from "bun:test";

import { type PlanOptions, planParts } from "./transform.ts";

const defaults: PlanOptions = {
  stripFinalStop: true,
  videoPrefixes: ["https://videos.example.com/"],
  videoMode: "attachment",
  surroundingText: "replace",
  supportsVideo: true,
  maxTextLength: 4096,
};

const plan = (text: string, options: Partial<PlanOptions> = {}) =>
  planParts(text, { ...defaults, ...options });

describe("final full stop", () => {
  test("removes one final full stop", () => {
    expect(plan("Thanks.")).toEqual([{ kind: "text", text: "Thanks" }]);
  });

  test("keeps an ellipsis", () => {
    expect(plan("Wait...")).toEqual([{ kind: "text", text: "Wait..." }]);
  });

  test("keeps the full stop when disabled", () => {
    expect(plan("Thanks.", { stripFinalStop: false })).toEqual([
      { kind: "text", text: "Thanks." },
    ]);
  });

  test("drops a part that holds only a full stop", () => {
    expect(plan(".")).toEqual([]);
  });
});

describe("video links", () => {
  const reply = "Watch this: https://videos.example.com/intro.mp4 and tell me.";

  test("replace mode sends only the video", () => {
    expect(plan(reply)).toEqual([
      { kind: "video", url: "https://videos.example.com/intro.mp4" },
    ]);
  });

  test("separate mode sends the surrounding text around the video in order", () => {
    expect(plan(reply, { surroundingText: "separate" })).toEqual([
      { kind: "text", text: "Watch this:" },
      { kind: "video", url: "https://videos.example.com/intro.mp4" },
      { kind: "text", text: "and tell me" },
    ]);
  });

  test("separate mode omits empty text and keeps link punctuation out of the url", () => {
    expect(
      plan("Here it is https://videos.example.com/a.mp4.", {
        surroundingText: "separate",
      }),
    ).toEqual([
      { kind: "text", text: "Here it is" },
      { kind: "video", url: "https://videos.example.com/a.mp4" },
    ]);
  });

  test("text mode keeps the link as text", () => {
    expect(plan(reply, { videoMode: "text" })).toEqual([
      {
        kind: "text",
        text: "Watch this: https://videos.example.com/intro.mp4 and tell me",
      },
    ]);
  });

  test("a channel without video support keeps the link as text", () => {
    expect(plan(reply, { supportsVideo: false })).toEqual([
      {
        kind: "text",
        text: "Watch this: https://videos.example.com/intro.mp4 and tell me",
      },
    ]);
  });

  test("an unrelated link stays text", () => {
    expect(plan("See https://youtube.com/watch?v=1 now.")).toEqual([
      { kind: "text", text: "See https://youtube.com/watch?v=1 now" },
    ]);
  });
});

describe("length limit", () => {
  test("splits at the last paragraph boundary before the limit", () => {
    expect(
      plan("First para.\n\nSecond. Para two.", { maxTextLength: 20 }),
    ).toEqual([
      { kind: "text", text: "First para." },
      { kind: "text", text: "Second. Para two" },
    ]);
  });

  test("prefers a sentence boundary over a space", () => {
    expect(plan("One two. Three four five", { maxTextLength: 15 })).toEqual([
      { kind: "text", text: "One two." },
      { kind: "text", text: "Three four five" },
    ]);
  });

  test("falls back to a space and then to a hard cut", () => {
    expect(plan("aaaa bbbbbbbbbb", { maxTextLength: 6 })).toEqual([
      { kind: "text", text: "aaaa" },
      { kind: "text", text: "bbbbbb" },
      { kind: "text", text: "bbbb" },
    ]);
  });

  test("split parts keep every character except the boundary whitespace", () => {
    const text =
      "Line one is here\nLine two is here. And more words follow here";
    const parts = plan(text, { maxTextLength: 18, stripFinalStop: false });
    expect(parts).toEqual([
      { kind: "text", text: "Line one is here" },
      { kind: "text", text: "Line two is here." },
      { kind: "text", text: "And more words" },
      { kind: "text", text: "follow here" },
    ]);
  });
});
