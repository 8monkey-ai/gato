import { expect, test } from "bun:test";

import { plainText } from "./plain-text.ts";

test.each([
  ["**Bold** and __also bold__", "Bold and also bold"],
  ["*one* and _two_, (*three*)", "one and two, (three)"],
  ["Run `npm install` now", "Run npm install now"],
  ["# Title\n## Steps\nText with #hashtag", "Title\nSteps\nText with #hashtag"],
  [
    "See [our help](https://x.test/help).",
    "See our help (https://x.test/help).",
  ],
  ["- first\n* second\n1. third", "- first\n* second\n1. third"],
  ["snake_case_name and 2*3*4", "snake_case_name and 2*3*4"],
  ["https://x.test/_a_/b and *c*", "https://x.test/_a_/b and c"],
  ["`*kept*` stays", "*kept* stays"],
  ["a * b * c and _ lone", "a * b * c and _ lone"],
  ["**unclosed and *open", "**unclosed and *open"],
])("%p becomes %p", (markdown, text) => {
  expect(plainText(markdown)).toBe(text);
});
