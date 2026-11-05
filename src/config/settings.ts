import type { Env } from "./env.ts";

export const countries = ["MY", "PH"] as const;
export type Country = (typeof countries)[number];

export type OwnershipPolicy = "assigned" | "shared" | "unrestricted";

export interface DeliverySettings {
  boundary: "paragraph" | "line" | "whole";
  timing: "stream" | "complete";
  pacing: "fixed" | "typing" | "none";
  pauseMs: number;
  msPerWord: number;
  stripFinalPeriod: boolean;
  videoLinkPrefixes: string[];
  videoLinksAs: "attachment" | "text";
  videoSurroundingText: "replace" | "separate";
}

function parseDelivery(env: Env): DeliverySettings {
  return {
    boundary: env.oneOf(
      "DELIVERY_BOUNDARY",
      ["paragraph", "line", "whole"],
      "paragraph",
    ),
    timing: env.oneOf("DELIVERY_TIMING", ["stream", "complete"], "stream"),
    pacing: env.oneOf("DELIVERY_PACING", ["fixed", "typing", "none"], "fixed"),
    pauseMs: env.duration("DELIVERY_PAUSE", "750ms"),
    msPerWord: env.duration("DELIVERY_TYPING_PER_WORD", "1s"),
    stripFinalPeriod: env.bool("DELIVERY_STRIP_FINAL_PERIOD", true),
    videoLinkPrefixes: env.list("VIDEO_LINK_PREFIXES"),
    videoLinksAs: env.oneOf(
      "VIDEO_LINKS_AS",
      ["attachment", "text"],
      "attachment",
    ),
    videoSurroundingText: env.oneOf(
      "VIDEO_SURROUNDING_TEXT",
      ["replace", "separate"],
      "replace",
    ),
  };
}

function parseTimezone(env: Env) {
  const timezone = env.string("TIMEZONE", "UTC");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error(
      `Invalid TIMEZONE="${timezone}". Use an IANA name such as "Asia/Kuala_Lumpur".`,
    );
  }
  return timezone;
}

export function parseSettings(env: Env) {
  return {
    port: env.int("PORT", 3000),
    dataDir: env.string("DATA_DIR"),
    country: env.oneOf("COUNTRY", countries),
    timezone: parseTimezone(env),
    ownershipPolicy: env.oneOf<OwnershipPolicy>(
      "OWNERSHIP_POLICY",
      ["assigned", "shared", "unrestricted"],
      "assigned",
    ),
    gateway: {
      apiKey: env.string("OPENROUTER_API_KEY"),
      baseURL: env.optional("OPENROUTER_BASE_URL"),
    },
    model: env.string("MODEL"),
    limits: {
      maxSteps: env.int("TURN_MAX_STEPS", 12),
      maxDurationMs: env.duration("TURN_MAX_DURATION", "2m"),
    },
    delivery: parseDelivery(env),
    shutdownGraceMs: env.duration("SHUTDOWN_GRACE", "20s"),
  };
}

export type Settings = ReturnType<typeof parseSettings>;
