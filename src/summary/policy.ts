const day = 24 * 60 * 60 * 1000;

export type SummaryDecision = "reuse" | "skip" | "generate";

export function monthBefore(now: Date): Date {
  const start = new Date(now);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return start;
}

/** Applies the three-day and recent-month rules of the contact summary. */
export function decideSummary(
  now: Date,
  summaryDate: Date | undefined,
  oldestRecentMessage: Date | undefined,
): SummaryDecision {
  if (summaryDate) {
    return now.getTime() - summaryDate.getTime() < 3 * day
      ? "reuse"
      : "generate";
  }
  if (!oldestRecentMessage) return "skip";
  return now.getTime() - oldestRecentMessage.getTime() >= 3 * day
    ? "generate"
    : "skip";
}
