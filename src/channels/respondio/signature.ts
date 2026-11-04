import { createHmac, timingSafeEqual } from "node:crypto";

export function hasValidSignature(
  body: Uint8Array,
  signature: string | null,
  keys: string[],
): boolean {
  if (!signature) return false;
  const given = Buffer.from(signature);
  return keys.some((key) => {
    const expected = Buffer.from(
      createHmac("sha256", key).update(body).digest("base64"),
    );
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}
