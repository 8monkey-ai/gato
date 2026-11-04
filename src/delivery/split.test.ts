import { describe, expect, test } from "bun:test";

import { createSplitter } from "./split.ts";

describe("createSplitter", () => {
  test("paragraph mode finds a boundary split across deltas", () => {
    const splitter = createSplitter("paragraph");
    expect(splitter.push("Hello there.\n")).toEqual([]);
    expect(splitter.push("\nHow can I")).toEqual(["Hello there."]);
    expect(splitter.push(" help?")).toEqual([]);
    expect(splitter.end()).toEqual(["How can I help?"]);
  });

  test("paragraph mode treats a run of blank lines as one boundary", () => {
    const splitter = createSplitter("paragraph");
    expect(splitter.push("One\n\n\n \n\nTwo\nstill two\n\nThree")).toEqual([
      "One",
      "Two\nstill two",
    ]);
    expect(splitter.end()).toEqual(["Three"]);
  });

  test("line mode splits at each newline and drops empty lines", () => {
    const splitter = createSplitter("line");
    expect(splitter.push("a\n")).toEqual(["a"]);
    expect(splitter.push("\n  b  \r\nc")).toEqual(["b"]);
    expect(splitter.end()).toEqual(["c"]);
  });

  test("whole mode returns one trimmed part at the end", () => {
    const splitter = createSplitter("whole");
    expect(splitter.push("One\n\nTwo")).toEqual([]);
    expect(splitter.push("\n")).toEqual([]);
    expect(splitter.end()).toEqual(["One\n\nTwo"]);
  });

  test("end returns nothing for whitespace only", () => {
    const splitter = createSplitter("paragraph");
    expect(splitter.push(" \n\n ")).toEqual([]);
    expect(splitter.end()).toEqual([]);
  });
});
