export type ToolOutcome = { output: unknown; isError: boolean };
export type AgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
  execute(input: unknown, signal: AbortSignal): Promise<ToolOutcome>;
};
