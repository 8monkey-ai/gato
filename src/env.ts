export type Env = Record<string, string | undefined>;

export const envList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
