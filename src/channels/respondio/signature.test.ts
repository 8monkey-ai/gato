import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { hasValidSignature } from "./signature.ts";

const body = new TextEncoder().encode('{"event_type":"message.received"}');
const sign = (key: string) =>
  createHmac("sha256", key).update(body).digest("base64");

test("accepts a signature made with any configured key", () => {
  expect(hasValidSignature(body, sign("second"), ["first", "second"])).toBe(
    true,
  );
});

test("rejects a missing, foreign, or malformed signature", () => {
  expect(hasValidSignature(body, null, ["first"])).toBe(false);
  expect(hasValidSignature(body, sign("other"), ["first"])).toBe(false);
  expect(hasValidSignature(body, "short", ["first"])).toBe(false);
});

test("rejects a signature over a different body", () => {
  const changed = new TextEncoder().encode('{"event_type":"message.sent"}');
  expect(hasValidSignature(changed, sign("first"), ["first"])).toBe(false);
});
