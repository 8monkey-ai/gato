export type Hours = { from: number; to: number };

export function dueMilestone(
  customerAt: number,
  activity: readonly number[],
  milestonesMs: readonly number[],
  now: number,
): number | undefined {
  const due = milestonesMs
    .map((offset) => customerAt + offset)
    .filter((at) => at <= now && !activity.some((active) => active >= at));
  return due.length ? Math.min(...due) : undefined;
}

export function parseHours(value: string): Hours {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Use the form HH:MM-HH:MM, not "${value}"`);
  const [from, to] = [minutes(match[1], match[2]), minutes(match[3], match[4])];
  if (from > 1440 || to > 1440)
    throw new Error(`Hours must be between 00:00 and 24:00: "${value}"`);
  return { from, to };
}

const minutes = (h = "0", m = "0") => Number(h) * 60 + Number(m);

export function withinHours(
  now: Date,
  hours: Hours,
  timeZone: string,
): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  const local = minutes(part("hour"), part("minute"));
  return hours.from <= hours.to
    ? local >= hours.from && local < hours.to
    : local >= hours.from || local < hours.to;
}
