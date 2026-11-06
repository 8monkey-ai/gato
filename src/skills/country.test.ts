import { expect, test } from "bun:test";

import { filterCountry } from "./country.ts";

const text =
  "Common.\n:::my\nOnly MY.\n:::\n:::ph\nOnly PH.\n:::\nPrice my[RM 10]ph[PHP 100] today. Army[1] stays.";

test("keeps common and selected country text and removes all markers", () => {
  expect(filterCountry(text, "my")).toBe(
    "Common.\nOnly MY.\nPrice RM 10 today. Army[1] stays.",
  );
  expect(filterCountry(text, "ph")).toBe(
    "Common.\nOnly PH.\nPrice PHP 100 today. Army[1] stays.",
  );
});

test("inline text can hold markdown links", () => {
  expect(filterCountry("See my[[rates](https://x.my)].", "my")).toBe(
    "See [rates](https://x.my).",
  );
});

test("malformed or ambiguous markup is refused", () => {
  expect(() => filterCountry(":::my\n:::ph\n:::\n:::", "my")).toThrow(
    "cannot nest",
  );
  expect(() => filterCountry(":::my\ntext", "my")).toThrow(
    "unclosed :::my block",
  );
  expect(() => filterCountry(":::\n", "my")).toThrow(
    "block end without a country block",
  );
  expect(() => filterCountry("my[open", "my")).toThrow("unclosed my[ marker");
  expect(() => filterCountry("my[a ph[b]]", "my")).toThrow(
    "nested country markers",
  );
  expect(() => filterCountry(":::ph\nph[x]\n:::", "my")).toThrow(
    "inside a country block",
  );
});
