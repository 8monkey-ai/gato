import { z } from "zod";

import { type Env, readEnv } from "../config/env.ts";

const timeZone = z
  .string()
  .transform((zone, ctx) => {
    const id = timeZoneId(zone);
    if (id) return id;
    ctx.addIssue({
      code: "custom",
      message:
        "expected an IANA time zone name such as UTC or Asia/Kuala_Lumpur, not an offset or a date-time",
    });
    return z.NEVER;
  })
  .default("UTC");

export function readTimeZone(env: Env = process.env): string {
  return readEnv("GATO_TIMEZONE", timeZone, env);
}

/** YYYY-MM-DD of the instant in the zone. */
export function localDate(at: number, zone: string): string {
  return zoned(at, zone).toPlainDate().toString();
}

/**
 * The same local time one calendar month earlier. A day the earlier month lacks becomes
 * its last day: 31 March gives 28 or 29 February.
 */
export function calendarMonthBefore(at: number, zone: string): number {
  return zoned(at, zone).subtract({ months: 1 }).epochMilliseconds;
}

/** Minutes since local midnight in the zone, 0 to 1439. */
export function minutesOfDay(at: number, zone: string): number {
  const time = zoned(at, zone);
  return time.hour * 60 + time.minute;
}

function zoned(at: number, zone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone);
}

/** The canonical id, for example "Asia/Manila" for "asia/manila". */
function timeZoneId(zone: string): string | undefined {
  // Temporal also accepts offsets and date-times, which start with a sign or a digit.
  if (!/^[A-Za-z]/.test(zone)) return undefined;
  try {
    return zoned(0, zone).timeZoneId;
  } catch {
    return undefined;
  }
}
