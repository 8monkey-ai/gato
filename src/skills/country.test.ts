import { describe, expect, test } from "bun:test";

import { CountryMarkupError, filterCountry } from "./country.ts";

describe("filterCountry", () => {
  const text = [
    "Common.",
    ":::my",
    "Malaysia only.",
    ":::",
    ":::ph",
    "Philippines only.",
    ":::",
    "Pay with my[DuitNow]ph[GCash] today.",
  ].join("\n");

  test("keeps common and Malaysian text and removes all markers", () => {
    expect(filterCountry(text, "my")).toBe(
      "Common.\nMalaysia only.\nPay with DuitNow today.",
    );
  });

  test("keeps common and Philippine text", () => {
    expect(filterCountry(text, "ph")).toBe(
      "Common.\nPhilippines only.\nPay with GCash today.",
    );
  });

  test("keeps brackets inside inline text", () => {
    expect(filterCountry("See my[[form](https://x.my)].", "my")).toBe(
      "See [form](https://x.my).",
    );
  });

  test("keeps inline text that continues over more lines", () => {
    const multiline =
      "Steps:\nmy[1. Check email.\n   - Paid: refund.]\nph[None.]\nDone.";
    expect(filterCountry(multiline, "my")).toBe(
      "Steps:\n1. Check email.\n   - Paid: refund.\n\nDone.",
    );
    expect(filterCountry(multiline, "ph")).toBe("Steps:\n\nNone.\nDone.");
  });

  test("does not treat words that end in my or ph as markers", () => {
    expect(filterCountry("army[1] graph[2]", "my")).toBe("army[1] graph[2]");
  });

  test.each([
    [":::my\n:::ph\nx\n:::\n:::"],
    [":::my\nnot closed"],
    ["closed\n:::"],
    ["my[not closed"],
    ["my[a ph[b]]"],
    [":::my\nmy[x]\n:::"],
    ["my[starts outside\n:::ph\nends inside]\n:::"],
  ])("rejects malformed markup %#", (input) => {
    expect(() => filterCountry(input, "my")).toThrow(CountryMarkupError);
  });
});
