export function monthBefore(now: Date, timezone: string) {
  const zoned = Temporal.Instant.fromEpochMilliseconds(
    now.getTime(),
  ).toZonedDateTimeISO(timezone);
  return new Date(zoned.subtract({ months: 1 }).epochMilliseconds);
}

export function formatLocal(at: string, timezone: string) {
  const zoned = Temporal.Instant.from(at).toZonedDateTimeISO(timezone);
  return `${zoned.toPlainDate().toString()} ${zoned.toPlainTime().toString({ smallestUnit: "minute" })}`;
}

export function today(timezone: string) {
  return Temporal.Now.plainDateISO(timezone).toString();
}
