import { describe, expect, test } from "bun:test";

import { createPartSplitter, toSegments, wordCount } from "./parts.ts";

const allMedia = new Set(["image", "video", "audio", "document"] as const);

describe("createPartSplitter", () => {
  test("emits each part as soon as its boundary arrives", () => {
    const parts: string[] = [];
    const splitter = createPartSplitter("\n\n", (part) => parts.push(part));
    splitter.push("Hello there!\n");
    expect(parts).toEqual([]);
    splitter.push("\nHow are");
    expect(parts).toEqual(["Hello there!"]);
    splitter.push(" you?");
    expect(splitter.pending()).toBe("How are you?");
    splitter.flush();
    expect(parts).toEqual(["Hello there!", "How are you?"]);
  });

  test("omits empty parts and uses a configured boundary", () => {
    const parts: string[] = [];
    const splitter = createPartSplitter("|", (part) => parts.push(part));
    splitter.push("a||  |b|");
    splitter.flush();
    expect(parts).toEqual(["a", "b"]);
  });
});

describe("toSegments", () => {
  test("sends a media URL as an attachment between text messages", () => {
    expect(
      toSegments(
        "Look: https://x.test/a/photo.JPG?size=2 nice, right?",
        4096,
        allMedia,
      ),
    ).toEqual([
      { text: "Look:" },
      { media: "image", url: "https://x.test/a/photo.JPG?size=2" },
      { text: "nice, right?" },
    ]);
  });

  test("keeps the trailing punctuation as text", () => {
    expect(
      toSegments("Menu: https://x.test/menu.pdf.", 4096, allMedia),
    ).toEqual([
      { text: "Menu:" },
      { media: "document", url: "https://x.test/menu.pdf" },
      { text: "." },
    ]);
  });

  test("sends the media URL of a markdown link without the link markup", () => {
    expect(
      toSegments(
        "Photo: [Latte](https://x.test/latte.jpg) enjoy",
        4096,
        allMedia,
      ),
    ).toEqual([
      { text: "Photo:" },
      { media: "image", url: "https://x.test/latte.jpg" },
      { text: "enjoy" },
    ]);
  });

  test("keeps other URLs and unsendable media as text", () => {
    expect(
      toSegments(
        "See https://x.test/page and https://x.test/v.mp4",
        4096,
        new Set(["image"]),
      ),
    ).toEqual([{ text: "See https://x.test/page and https://x.test/v.mp4" }]);
  });
});

describe("toSegments limits", () => {
  test("splits text longer than the channel limit at spaces", () => {
    expect(toSegments("one two three", 8, allMedia)).toEqual([
      { text: "one two" },
      { text: "three" },
    ]);
  });
});

test("wordCount counts words of text and zero for media", () => {
  expect(wordCount({ text: " Hello  big world " })).toBe(3);
  expect(wordCount({ media: "image", url: "https://x.test/a.png" })).toBe(0);
});
