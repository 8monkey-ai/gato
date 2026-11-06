/**
 * Returns the earliest passed milestone without agent activity at or after it.
 * Milestones count from the latest real customer message.
 */
export function selectMilestone(
  now: Date,
  customerAt: Date | undefined,
  agentAt: Date | undefined,
  milestones: number[],
): number | undefined {
  if (!customerAt) return undefined;
  for (const milestone of milestones) {
    const due = customerAt.getTime() + milestone;
    if (now.getTime() < due) return undefined;
    if (!agentAt || agentAt.getTime() < due) return milestone;
  }
  return undefined;
}

export interface Hours {
  from: number;
  to: number;
}

/** Hours are minutes after local midnight. A range such as 22:00-06:00 passes midnight. */
export function withinHours(now: Date, timezone: string, hours: Hours) {
  const [h = 0, m = 0] = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(now)
    .split(":")
    .map(Number);
  const minute = h * 60 + m;
  return hours.from <= hours.to
    ? minute >= hours.from && minute < hours.to
    : minute >= hours.from || minute < hours.to;
}
