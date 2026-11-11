import { z } from "zod";

import { type Hours, parseHours } from "./nudges/policy.ts";
import { countries } from "./skills/country.ts";

const seconds = (fallback: number) =>
  z.coerce.number().positive().default(fallback);
const optionalText = z.string().trim().min(1).optional().catch(undefined);

const schema = z.object({
  HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  CONVERSATIONS_DIR: z.string().min(1),
  SKILLS_DIR: z.string().min(1),
  PROMPTS_DIR: optionalText,
  AGENT_COUNTRY: z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(countries)),
  AGENT_TIMEZONE: z
    .string()
    .default("UTC")
    .refine(
      (zone) =>
        Intl.supportedValuesOf("timeZone").includes(zone) || zone === "UTC",
      {
        error: "Use an IANA timezone name such as Asia/Kuala_Lumpur",
      },
    ),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  AGENT_MODEL: z.string().min(1),
  SUMMARY_MODEL: optionalText,
  IMAGE_PREPARATION_MODEL: optionalText,
  DOCUMENT_PREPARATION_MODEL: optionalText,
  AUDIO_PREPARATION_MODEL: optionalText,
  TURN_TIMEOUT_SECONDS: seconds(120),
  TURN_MAX_MODEL_CALLS: z.coerce.number().int().positive().default(12),
  DELIVERY_MESSAGE_BOUNDARY: z
    .string()
    .default("\\n\\n")
    .transform((value) => value.replaceAll("\\n", "\n").replaceAll("\\t", "\t"))
    .pipe(z.string().min(1)),
  DELIVERY_PACING: z.enum(["typing", "none"]).default("typing"),
  DELIVERY_TYPING_SECONDS_PER_WORD: seconds(1),
  NUDGES_ENABLED: z.stringbool().default(true),
  NUDGES_CHECK_INTERVAL_SECONDS: seconds(300),
  NUDGES_MILESTONES_MINUTES: z
    .string()
    .default("5,35,755,765")
    .transform((value) => value.split(",").map(Number))
    .pipe(z.array(z.number().positive()).min(1)),
  NUDGES_PERMITTED_HOURS: z
    .string()
    .optional()
    .transform((value, context): Hours | undefined => {
      if (!value) return undefined;
      try {
        return parseHours(value);
      } catch (error) {
        context.addIssue({ code: "custom", message: (error as Error).message });
        return z.NEVER;
      }
    }),
  SHUTDOWN_TIMEOUT_SECONDS: seconds(30),
});

export function readConfig(env: Record<string, string | undefined>) {
  const parsed = schema.safeParse(env);
  if (parsed.success) return toConfig(parsed.data);
  const problems = parsed.error.issues.map(
    (i) => `${i.path.join(".")}: ${i.message}`,
  );
  throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
}

function toConfig(env: z.infer<typeof schema>) {
  return {
    port: env.HTTP_PORT,
    conversationsDir: env.CONVERSATIONS_DIR,
    skillsDir: env.SKILLS_DIR,
    promptsDir: env.PROMPTS_DIR,
    country: env.AGENT_COUNTRY,
    timezone: env.AGENT_TIMEZONE,
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: env.OPENROUTER_BASE_URL,
    },
    models: {
      agent: env.AGENT_MODEL,
      summary: env.SUMMARY_MODEL ?? env.AGENT_MODEL,
      preparation: {
        image: env.IMAGE_PREPARATION_MODEL,
        document: env.DOCUMENT_PREPARATION_MODEL,
        audio: env.AUDIO_PREPARATION_MODEL,
      },
    },
    turn: {
      timeoutMs: env.TURN_TIMEOUT_SECONDS * 1000,
      maxModelCalls: env.TURN_MAX_MODEL_CALLS,
    },
    delivery: {
      boundary: env.DELIVERY_MESSAGE_BOUNDARY,
      msPerWord:
        env.DELIVERY_PACING === "typing"
          ? env.DELIVERY_TYPING_SECONDS_PER_WORD * 1000
          : 0,
    },
    nudges: {
      enabled: env.NUDGES_ENABLED,
      intervalMs: env.NUDGES_CHECK_INTERVAL_SECONDS * 1000,
      milestonesMs: env.NUDGES_MILESTONES_MINUTES.map((m) => m * 60_000),
      hours: env.NUDGES_PERMITTED_HOURS,
    },
    shutdownMs: env.SHUTDOWN_TIMEOUT_SECONDS * 1000,
  };
}

export type Config = ReturnType<typeof toConfig>;
