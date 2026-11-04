import pino, { type DestinationStream, type Logger } from "pino";
import { z } from "zod";

import { type Env, readEnv } from "../config/env.ts";

export type { Logger };

const level = z
  .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
  .default("info");
const credentialKey =
  /(token|secret|password|authorization|api_?key|signing_?keys?)$/i;
const personalKeys = new Set(["text", "caption", "phone", "email"]);
const serializedErrorPrototype: unknown = Object.getPrototypeOf(
  pino.stdSerializers.err(new Error()),
);

export function createLogger(
  env: Env = process.env,
  destination?: DestinationStream,
): Logger {
  // Pino runs formatters before serializers. Its default err serializer would rewrite the
  // redacted err, so this one keeps it.
  const options = {
    level: readEnv("GATO_LOG_LEVEL", level, env),
    serializers: { err: (value: unknown) => redact(value, new WeakSet()) },
    formatters: { log: redactRoot, bindings: redactRoot },
  };
  return destination ? pino(options, destination) : pino(options);
}

function redactRoot(fields: object): Record<string, unknown> {
  return redactFields(fields, new WeakSet());
}

function isSensitive(key: string): boolean {
  return personalKeys.has(key) || credentialKey.test(key);
}

function redactFields(
  fields: object,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      isSensitive(key) ? "[redacted]" : redact(value, ancestors),
    ]),
  );
}

function redact(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return redact(pino.stdSerializers.err(value), ancestors);
  }
  if (typeof value !== "object" || value === null) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== serializedErrorPrototype
  ) {
    return value;
  }
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  const redacted = Array.isArray(value)
    ? value.map((item) => redact(item, ancestors))
    : redactFields(value, ancestors);
  ancestors.delete(value);
  return redacted;
}
