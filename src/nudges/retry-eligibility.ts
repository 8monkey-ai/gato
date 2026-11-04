export function retryEligible(input: {
  attemptAt: Date;
  mayAnswer: boolean;
  substantiveMessageTimes: Date[];
}): boolean {
  const attemptAt = input.attemptAt.getTime();
  return (
    input.mayAnswer &&
    !input.substantiveMessageTimes.some((at) => at.getTime() > attemptAt)
  );
}
