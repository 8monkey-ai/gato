export function retryEligible(input: {
  attemptAt: Date;
  open: boolean;
  agentOwned: boolean;
  substantiveMessageTimes: Date[];
}): boolean {
  const attemptAt = input.attemptAt.getTime();
  return (
    input.open &&
    input.agentOwned &&
    !input.substantiveMessageTimes.some((at) => at.getTime() > attemptAt)
  );
}
