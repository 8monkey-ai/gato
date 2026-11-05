import { expect, test } from "bun:test";

import { filterCountry } from "./country.ts";

const text = `Common.
Call my[1-800-MY]ph[1-800-PH] now.
:::my
Malaysia only.
:::
:::ph
Philippines only.
:::
End.`;

test("keeps common and selected-country material without markers", () => {
  expect(filterCountry(text, "MY")).toBe(
    "Common.\nCall 1-800-MY now.\nMalaysia only.\nEnd.",
  );
  expect(filterCountry(text, "PH")).toBe(
    "Common.\nCall 1-800-PH now.\nPhilippines only.\nEnd.",
  );
});

test("does not treat words that end in my or ph as markers", () => {
  expect(filterCountry("See army[1] and graph[2].", "MY")).toBe(
    "See army[1] and graph[2].",
  );
});

test("rejects nested, overlapping and unclosed sections", () => {
  expect(() => filterCountry(":::my\n:::ph\n:::", "MY")).toThrow(
    "Nested country block",
  );
  expect(() => filterCountry(":::my\nmy[x]\n:::", "MY")).toThrow(
    "inside a country block",
  );
  expect(() => filterCountry(":::my\nopen", "MY")).toThrow("has no end");
  expect(() => filterCountry("my[unclosed", "MY")).toThrow("Unclosed");
  expect(() => filterCountry(":::", "MY")).toThrow("without start");
});
