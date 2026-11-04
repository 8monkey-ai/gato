const THREE_DAYS_MS = 72 * 3_600_000;

export function summaryDecision(input: {
  now: Date;
  summaryGeneratedAt?: Date;
  oldestRecentMessageAt?: Date;
}): "reuse" | "generate" | "refresh" | "none" {
  const now = input.now.getTime();
  if (input.summaryGeneratedAt) {
    const age = now - input.summaryGeneratedAt.getTime();
    return age < THREE_DAYS_MS ? "reuse" : "refresh";
  }
  const oldest = input.oldestRecentMessageAt;
  if (oldest && now - oldest.getTime() >= THREE_DAYS_MS) return "generate";
  return "none";
}

export function recentMonthStart(now: Date, timeZone: string): Date {
  const wall = wallClock(now, timeZone);
  const lastDay = new Date(Date.UTC(wall.year, wall.month - 1, 0)).getUTCDate();
  const target = Date.UTC(
    wall.year,
    wall.month - 2,
    Math.min(wall.day, lastDay),
    wall.hour,
    wall.minute,
    wall.second,
    now.getUTCMilliseconds(),
  );
  const firstGuess = target - offsetMs(new Date(target), timeZone);
  return new Date(target - offsetMs(new Date(firstGuess), timeZone));
}

function offsetMs(instant: Date, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    instant.getUTCMilliseconds(),
  );
  return asUtc - instant.getTime();
}

function wallClock(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}
