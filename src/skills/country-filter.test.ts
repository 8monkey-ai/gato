import { expect, test } from "bun:test";

import { filterCountry } from "./country-filter.ts";

test("keeps the inline text of the selected country only", () => {
  const text = "Call my[+60 3 1234]ph[+63 2 5678] today.";
  expect(filterCountry(text, "MY")).toEqual({
    ok: true,
    text: "Call +60 3 1234 today.",
  });
  expect(filterCountry(text, "PH")).toEqual({
    ok: true,
    text: "Call +63 2 5678 today.",
  });
});

test("keeps balanced brackets inside an inline section", () => {
  const text = "See my[[the guide](https://example.com/my)].";
  expect(filterCountry(text, "MY")).toEqual({
    ok: true,
    text: "See [the guide](https://example.com/my).",
  });
});

test("keeps the block of the selected country and removes the markers", () => {
  const text =
    "Common.\n:::my\nMalaysia only.\n:::\n:::ph\nPhilippines only.\n:::\nEnd.";
  expect(filterCountry(text, "MY")).toEqual({
    ok: true,
    text: "Common.\nMalaysia only.\nEnd.",
  });
  expect(filterCountry(text, "PH")).toEqual({
    ok: true,
    text: "Common.\nPhilippines only.\nEnd.",
  });
});

test("accepts CRLF line ends", () => {
  expect(filterCountry("A\r\n:::ph\r\nB\r\n:::\r\nC", "MY")).toEqual({
    ok: true,
    text: "A\r\nC",
  });
});

test("does not treat a marker inside a word as a marker", () => {
  expect(filterCountry("army[1] and graph[2]", "PH")).toEqual({
    ok: true,
    text: "army[1] and graph[2]",
  });
});

test("ignores markers with other letter case", () => {
  expect(filterCountry("MY[x]\n:::MY", "PH")).toEqual({
    ok: true,
    text: "MY[x]\n:::MY",
  });
});

test("rejects a nested block", () => {
  expect(filterCountry("a\n:::my\nb\n:::ph\nc\n:::\n:::", "MY")).toEqual({
    ok: false,
    error: "line 4: country block opens inside the block of line 2",
  });
});

test("rejects an unclosed block", () => {
  expect(filterCountry("a\n\n:::ph\nb", "MY")).toEqual({
    ok: false,
    error: "line 3: country block is not closed",
  });
});

test("rejects a stray block close", () => {
  expect(filterCountry("a\n:::", "MY")).toEqual({
    ok: false,
    error: 'line 2: ":::" closes no country block',
  });
});

test("rejects an unclosed inline section", () => {
  expect(filterCountry("a\nb my[c [d]", "MY")).toEqual({
    ok: false,
    error: 'line 2: "my[" is not closed',
  });
});

test("rejects an inline section inside another one", () => {
  expect(filterCountry("my[a ph[b]]", "MY")).toEqual({
    ok: false,
    error: 'line 1: "my[" contains a country section',
  });
});

test("rejects an inline section inside a block", () => {
  expect(filterCountry(":::my\nph[b]\n:::", "MY")).toEqual({
    ok: false,
    error: 'line 2: "ph[" is inside a country block',
  });
});
