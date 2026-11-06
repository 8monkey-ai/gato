const secrets = new Set<string>();

export function protectSecret(value: string | undefined) {
  if (value && value.length >= 6) secrets.add(value);
}

export function redact(text: string): string {
  let result = text;
  for (const secret of secrets) result = result.replaceAll(secret, "[secret]");
  return result;
}

type Fields = Record<string, unknown>;

function write(
  level: "info" | "warn" | "error",
  event: string,
  fields: Fields,
) {
  const line = JSON.stringify(
    { time: new Date().toISOString(), level, event, ...fields },
    (_, v: unknown) => (v instanceof Error ? v.message : v),
  );
  console[level === "info" ? "log" : level](redact(line));
}

export const log = {
  info: (event: string, fields: Fields = {}) => write("info", event, fields),
  warn: (event: string, fields: Fields = {}) => write("warn", event, fields),
  error: (event: string, fields: Fields = {}) => write("error", event, fields),
};
