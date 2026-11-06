import type { z } from "zod";

export const list = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** Reads settings from environment variables. An empty value counts as absent. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined>,
  title: string,
): z.output<T> {
  const present = Object.entries(env).filter(([, value]) => value !== "");
  const result = schema.safeParse(Object.fromEntries(present), {
    error: (issue) => (issue.input === undefined ? "is required" : undefined),
  });
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
  throw new Error(`Invalid ${title}:\n${problems.join("\n")}`);
}
