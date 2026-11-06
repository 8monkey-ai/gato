import { expect, test } from "bun:test";

import { planPart, type VideoPolicy } from "./plan.ts";

const policy: VideoPolicy = {
  links: "attachment",
  surroundingText: "replace",
  approvedUrls: ["https://v.example/"],
};
const channel = { textLimit: 20, sendsVideo: true };

test("an approved video link replaces the part by default", () => {
  expect(planPart("See https://v.example/a.mp4.", policy, channel)).toEqual([
    { kind: "video", url: "https://v.example/a.mp4" },
  ]);
});

test("the separate option keeps the text around the video in order", () => {
  expect(
    planPart(
      "See https://v.example/a.mp4 now",
      { ...policy, surroundingText: "separate" },
      channel,
    ),
  ).toEqual([
    { kind: "text", text: "See" },
    { kind: "video", url: "https://v.example/a.mp4" },
    { kind: "text", text: "now" },
  ]);
});

test("a channel without video keeps the link as text, and long text splits at spaces", () => {
  expect(
    planPart("See https://v.example/a.mp4", policy, {
      textLimit: 100,
      sendsVideo: false,
    }),
  ).toEqual([{ kind: "text", text: "See https://v.example/a.mp4" }]);
  expect(planPart("aaaa bbbb cccc dddd eeee ffff", policy, channel)).toEqual([
    { kind: "text", text: "aaaa bbbb cccc dddd" },
    { kind: "text", text: "eeee ffff" },
  ]);
});
