import { createHmac, timingSafeEqual } from "node:crypto";

export function signatureOf(key: string, body: unknown) {
  return createHmac("sha256", key)
    .update(JSON.stringify(body))
    .digest("base64");
}

export function verifySignature(
  keys: string[],
  body: unknown,
  signature: string | null,
) {
  if (!signature) return false;
  const given = Buffer.from(signature);
  return keys.some((key) => {
    const expected = Buffer.from(signatureOf(key, body));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}
