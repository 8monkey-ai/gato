type Fields = Record<string, unknown>;
type Level = "info" | "warn" | "error";

export type Logger = {
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  child(fields: Fields): Logger;
};

const sensitiveKey =
  /token|key|secret|password|authorization|phone|email|text/i;

function redact(value: unknown): unknown {
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      sensitiveKey.test(key) ? "[redacted]" : redact(inner),
    ]),
  );
}

export function createLogger(
  base: Fields = {},
  write: (line: string) => void = (line) => process.stdout.write(line + "\n"),
): Logger {
  const emit =
    (level: Level) =>
    (event: string, fields: Fields = {}) =>
      write(
        JSON.stringify(
          redact({
            time: new Date().toISOString(),
            level,
            event,
            ...base,
            ...fields,
          }),
        ),
      );
  return {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (fields) => createLogger({ ...base, ...fields }, write),
  };
}
