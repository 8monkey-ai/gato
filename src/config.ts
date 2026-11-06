import { z } from "zod";

import type { Country } from "./skills/country.ts";

const durationPart = /(\d+)(h|m|s)/g;
const durationUnits = { h: 3_600_000, m: 60_000, s: 1000 } as const;

export function parseDuration(text: string): number {
  const trimmed = text.trim();
  if (!/^(\d+[hms])+$/.test(trimmed))
    throw new Error(`"${text}" is not a duration such as 5m or 12h35m`);
  let total = 0;
  for (const [, amount, unit] of trimmed.matchAll(durationPart))
    total += Number(amount) * durationUnits[unit as keyof typeof durationUnits];
  return total;
}

const list = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const flag = z.enum(["true", "false"]).transform((value) => value === "true");
const seconds = z.coerce
  .number()
  .positive()
  .transform((value) => value * 1000);

const hours = z
  .string()
  .regex(/^\d\d:\d\d-\d\d:\d\d$/, "use HH:MM-HH:MM, for example 09:00-18:00")
  .transform((text) => {
    const [from = 0, to = 0] = text.split("-").map((time) => {
      const [h = 0, m = 0] = time.split(":").map(Number);
      return h * 60 + m;
    });
    return { from, to };
  });

const timezone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "is not a known IANA time zone, for example Asia/Kuala_Lumpur");

const mcpServers = z.array(
  z.object({
    name: z.string().regex(/^[a-z0-9_]+$/, "use lowercase letters, digits, _"),
    url: z.url(),
    headers: z.record(z.string(), z.string()).default({}),
    tools: z.array(z.string()).min(1),
  }),
);

const schema = z.object({
  DATA_DIR: z.string().min(1),
  SKILLS_DIR: z.string().min(1),
  COUNTRY: z
    .enum(["MY", "PH"], "must be MY (Malaysia) or PH (the Philippines)")
    .transform((value) => value.toLowerCase() as Country),
  TIMEZONE: timezone.default("UTC"),
  PORT: z.coerce.number().int().min(0).default(3000),
  CHANNELS: z.string().transform(list).pipe(z.array(z.string()).min(1)),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  AGENT_MODEL: z.string().min(1),
  SUMMARY_MODEL: z.string().min(1).optional(),
  IMAGE_PREPARATION_MODEL: z.string().min(1).optional(),
  DOCUMENT_PREPARATION_MODEL: z.string().min(1).optional(),
  AUDIO_PREPARATION_MODEL: z.string().min(1).optional(),
  TURN_TIMEOUT_SECONDS: seconds.default(120),
  TURN_MAX_MODEL_CALLS: z.coerce.number().int().positive().default(12),
  SHUTDOWN_TIMEOUT_SECONDS: seconds.default(30),
  DELIVERY_MESSAGE_BOUNDARY: z
    .string()
    .min(1)
    .transform((text) => text.replaceAll("\\n", "\n").replaceAll("\\t", "\t"))
    .default("\n\n"),
  DELIVERY_PACING: z.enum(["typing", "none"]).default("typing"),
  DELIVERY_TYPING_SECONDS_PER_WORD: z.coerce.number().min(0).default(1),
  DELIVERY_VIDEO_LINKS: z.enum(["attachment", "text"]).default("attachment"),
  DELIVERY_VIDEO_LINK_TEXT: z.enum(["replace", "separate"]).default("replace"),
  DELIVERY_APPROVED_VIDEO_URLS: z.string().default("").transform(list),
  NUDGE_ENABLED: flag.default(true),
  NUDGE_CHECK_INTERVAL_SECONDS: seconds.default(300),
  NUDGE_MILESTONES: z
    .string()
    .default("5m,35m,12h35m,12h45m")
    .transform((text, context) => {
      try {
        return list(text)
          .map(parseDuration)
          .sort((a, b) => a - b);
      } catch (error) {
        context.addIssue((error as Error).message);
        return z.NEVER;
      }
    }),
  NUDGE_HOURS: hours.default({ from: 0, to: 24 * 60 }),
  MCP_SERVERS: z
    .string()
    .default("[]")
    .transform((text, context) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        context.addIssue("is not valid JSON");
        return z.NEVER;
      }
    })
    .pipe(mcpServers),
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: Record<string, string | undefined>): Config {
  const present = Object.entries(env).filter(([, value]) => value !== "");
  const result = schema.safeParse(Object.fromEntries(present));
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
  throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
}
