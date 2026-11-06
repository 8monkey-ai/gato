import { expect, test } from "bun:test";

import { createSegmenter } from "./segmenter.ts";

test("parts are emitted as soon as the boundary arrives, without empty parts", () => {
  const parts: string[] = [];
  const segmenter = createSegmenter("\n\n", (part) => parts.push(part));
  segmenter.push("Hello");
  segmenter.push(" there!\n");
  expect(parts).toEqual([]);
  segmenter.push("\n\n\nNext?");
  expect(parts).toEqual(["Hello there!"]);
  segmenter.flush();
  expect(parts).toEqual(["Hello there!", "Next?"]);
});
