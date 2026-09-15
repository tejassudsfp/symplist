import type { z } from "zod";

/** Input and output schemas of one Simon or MCP tool (§8.7, §14.6). */
export interface ToolContract<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> {
  input: Input;
  output: Output;
}

/** A feature's tool contracts, keyed by tool name (for example `task_context`). */
export type ToolContractMap = Readonly<Record<string, ToolContract>>;

/** Declares a feature's tool contracts with their literal names preserved. */
export function defineTools<const Tools extends ToolContractMap>(tools: Tools): Readonly<Tools> {
  return Object.freeze(tools);
}
