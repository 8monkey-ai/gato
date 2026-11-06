type LogFields = Record<string, string | number | boolean | undefined>;

function write(level: string, event: string, fields: LogFields) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }),
  );
}

/** Fields carry identifiers and outcomes only, never message text, names, or credentials. */
export const log = {
  info: (event: string, fields: LogFields = {}) => write("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => write("warn", event, fields),
  error: (event: string, fields: LogFields = {}) =>
    write("error", event, fields),
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
