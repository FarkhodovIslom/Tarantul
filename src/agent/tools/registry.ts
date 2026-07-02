import type { Tool, ToolSchema } from "./base.js";

const HINT = "\n\n[Analyze the error above and try a different approach.]";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get toolNames(): string[] {
    return [...this.tools.keys()];
  }

  get size(): number {
    return this.tools.size;
  }

  getDefinitions(): ToolSchema[] {
    return [...this.tools.values()].map((t) => t.toSchema());
  }

  prepareCall(
    name: string,
    params: Record<string, unknown>,
  ): { tool: Tool | null; params: Record<string, unknown>; error: string | null } {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        tool: null,
        params,
        error: `Error: Tool '${name}' not found. Available: ${this.toolNames.join(", ")}`,
      };
    }

    const castParams = tool.castParams(params);
    const errors = tool.validateParams(castParams);
    if (errors.length > 0) {
      return {
        tool,
        params: castParams,
        error: `Error: Invalid parameters for tool '${name}': ${errors.join("; ")}`,
      };
    }

    return { tool, params: castParams, error: null };
  }

  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    const { tool, params: castParams, error } = this.prepareCall(name, params);
    if (error) return error + HINT;

    try {
      const result = await tool!.execute(castParams);
      if (typeof result === "string" && result.startsWith("Error")) {
        return result + HINT;
      }
      return result;
    } catch (err) {
      return `Error executing ${name}: ${err}` + HINT;
    }
  }

  [Symbol.iterator](): IterableIterator<[string, Tool]> {
    return this.tools.entries();
  }
}
