import { expect, test } from "bun:test";

import type { DeliverySettings } from "../config/settings.ts";
import { shapeParts } from "./shape.ts";
import { splitAll } from "./split.ts";

const settings: DeliverySettings = {
  boundary: "paragraph",
  timing: "stream",
  pacing: "fixed",
  pauseMs: 750,
  msPerWord: 1000,
  stripFinalPeriod: true,
  videoLinkPrefixes: ["https://v.example/"],
  videoLinksAs: "attachment",
  videoSurroundingText: "replace",
};
const limits = { maxMessageLength: 10, videoAttachments: true };

test("splits on paragraph boundaries and drops empty parts", () => {
  expect(splitAll("a\n\n \n\nb\nc", "paragraph")).toEqual(["a", "b\nc"]);
  expect(splitAll("a\nb", "line")).toEqual(["a", "b"]);
  expect(splitAll("a\n\nb", "whole")).toEqual(["a\n\nb"]);
});

test("removes one final full stop but keeps an ellipsis", () => {
  expect(shapeParts("Done.", settings, limits)).toEqual([{ text: "Done" }]);
  expect(shapeParts("Wait...", settings, limits)).toEqual([
    { text: "Wait..." },
  ]);
});

test("splits long text at spaces within the limit", () => {
  expect(shapeParts("aaaa bbbb cccc", settings, limits)).toEqual([
    { text: "aaaa bbbb" },
    { text: "cccc" },
  ]);
});

test("converts approved video links only when the channel supports video", () => {
  expect(shapeParts("See https://v.example/a.mp4", settings, limits)).toEqual([
    { videoUrl: "https://v.example/a.mp4" },
  ]);
  expect(
    shapeParts("See https://v.example/a.mp4", settings, {
      ...limits,
      maxMessageLength: 100,
      videoAttachments: false,
    }),
  ).toEqual([{ text: "See https://v.example/a.mp4" }]);
});
