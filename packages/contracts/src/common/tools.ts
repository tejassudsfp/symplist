import type { z } from "./zod.ts";

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

/** Tool names are lowercase snake_case, as model providers and MCP clients expect. */
export const toolNamePattern = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Declares a feature's tool contracts with their literal names preserved. Throws when a tool name is
 * not lowercase snake_case of at most 64 characters.
 */
export function defineTools<const Tools extends ToolContractMap>(tools: Tools): Readonly<Tools> {
  for (const name of Object.keys(tools)) {
    if (!toolNamePattern.test(name)) {
      throw new Error(`Invalid tool name "${name}": use lowercase snake_case`);
    }
  }
  return Object.freeze(tools);
}
