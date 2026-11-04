import { z } from "zod";

export type Env = Record<string, string | undefined>;

export const integer = z
  .string()
  .regex(/^-?\d+$/, "expected an integer")
  .transform(Number)
  .pipe(z.int());

const unitMs = [86_400_000, 3_600_000, 60_000, 1_000, 1];
const durationPattern =
  /^(?=\d)(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/;

/** Milliseconds from units in the order d, h, m, s, ms, e.g. "5m" or "12h35m". */
export const duration = z.string().transform((text, ctx) => {
  const match = durationPattern.exec(text);
  if (!match) {
    ctx.addIssue({
      code: "custom",
      message: 'expected a duration such as "30s", "5m" or "12h35m"',
    });
    return z.NEVER;
  }
  return unitMs.reduce(
    (total, ms, i) => total + Number(match[i + 1] ?? 0) * ms,
    0,
  );
});

export function list<T>(item: z.ZodType<T, string>) {
  return z
    .string()
    .transform((text) =>
      text
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    )
    .pipe(z.array(item));
}

export function json<T extends z.ZodType>(schema: T) {
  return z
    .string()
    .transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "expected valid JSON" });
        return z.NEVER;
      }
    })
    .pipe(schema);
}

/** Reads one variable. An empty value counts as unset, so a schema default applies. */
export function readEnv<T extends z.ZodType>(
  name: string,
  schema: T,
  env: Env = process.env,
): z.output<T> {
  const raw = env[name] === "" ? undefined : env[name];
  const result = schema.safeParse(raw, {
    error: (issue) => {
      if (issue.code === "invalid_type" && issue.input === undefined) {
        return "Required";
      }
      // Zod reports a bad record key only as "Invalid key in record"; the key schema says why.
      if (issue.code === "invalid_key") return issue.issues[0]?.message;
      return undefined;
    },
  });
  if (result.success) return result.data;
  throw new Error(
    result.error.issues
      .map((issue) => `${formatPath(name, issue.path)}: ${issue.message}`)
      .join("\n"),
  );
}

function formatPath(name: string, path: PropertyKey[]): string {
  return path.reduce<string>(
    (text, key) =>
      typeof key === "number" ? `${text}[${key}]` : `${text}.${String(key)}`,
    name,
  );
}
