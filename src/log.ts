type Level = "info" | "warn" | "error";

type Fields = Record<string, unknown>;

export function log(level: Level, event: string, fields: Fields = {}) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "info") console.log(line);
  else console.error(line);
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
