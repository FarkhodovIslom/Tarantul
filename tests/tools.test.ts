import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../src/agent/tools/registry";
import { ReadFileTool, WriteFileTool, EditFileTool, ListDirTool } from "../src/agent/tools/filesystem";
import { ExecTool } from "../src/agent/tools/shell";
import { Tool } from "../src/agent/tools/base.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = join(tmpdir(), "tarantul-test-" + Date.now());

describe("ToolRegistry", () => {
  it("registers and executes tools", async () => {
    const registry = new ToolRegistry();
    const tool = new ReadFileTool();
    registry.register(tool);
    expect(registry.has("read_file")).toBe(true);
    expect(registry.toolNames).toContain("read_file");
    expect(registry.getDefinitions().length).toBe(1);
  });

  it("returns error for unknown tool", async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute("nonexistent", {});
    expect(result).toContain("Error");
  });
});

describe("ReadFileTool", () => {
  it("reads a file with line numbers", async () => {
    mkdirSync(TMP, { recursive: true });
    const fp = join(TMP, "test.txt");
    writeFileSync(fp, "hello\nworld\n");
    const tool = new ReadFileTool();
    const result = await tool.execute({ path: fp });
    expect(result).toContain("1| hello");
    expect(result).toContain("2| world");
  });

  it("returns error for missing file", async () => {
    const tool = new ReadFileTool();
    const result = await tool.execute({ path: "/nonexistent/path.txt" });
    expect(String(result)).toContain("Error");
  });
});

describe("WriteFileTool", () => {
  it("writes content to file", async () => {
    mkdirSync(TMP, { recursive: true });
    const fp = join(TMP, "write_test.txt");
    const tool = new WriteFileTool();
    const result = await tool.execute({ path: fp, content: "hello bun" });
    expect(result).toContain("Successfully wrote");
  });
});

describe("EditFileTool", () => {
  it("replaces text in file", async () => {
    mkdirSync(TMP, { recursive: true });
    const fp = join(TMP, "edit_test.txt");
    writeFileSync(fp, "foo bar baz");
    const tool = new EditFileTool();
    const result = await tool.execute({ path: fp, old_text: "bar", new_text: "QUX" });
    expect(result).toContain("Successfully edited");
  });

  it("returns warning for ambiguous match", async () => {
    mkdirSync(TMP, { recursive: true });
    const fp = join(TMP, "multi_test.txt");
    writeFileSync(fp, "aaa aaa aaa");
    const tool = new EditFileTool();
    const result = await tool.execute({ path: fp, old_text: "aaa", new_text: "bbb" });
    expect(String(result)).toContain("Warning");
  });
});

describe("ListDirTool", () => {
  it("lists directory", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, "file1.ts"), "");
    writeFileSync(join(TMP, "file2.ts"), "");
    const tool = new ListDirTool();
    const result = await tool.execute({ path: TMP });
    expect(String(result)).toContain("file1.ts");
  });
});

describe("ExecTool", () => {
  it("executes shell command", async () => {
    const tool = new ExecTool();
    const result = await tool.execute({ command: "echo hello" });
    expect(String(result)).toContain("hello");
  });

  it("blocks dangerous patterns", async () => {
    const tool = new ExecTool();
    const result = await tool.execute({ command: "rm -rf /" });
    expect(String(result)).toContain("Error");
    expect(String(result)).toContain("blocked");
  });

  it("captures stderr", async () => {
    const tool = new ExecTool();
    const result = await tool.execute({ command: "echo err >&2" });
    expect(String(result)).toContain("err");
  });

  it("handles timeout", async () => {
    const tool = new ExecTool({ timeout: 1 });
    const result = await tool.execute({ command: "sleep 10", timeout: 1 });
    expect(String(result)).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// Tool base — castParams / validateParams (via concrete subclass)
// ---------------------------------------------------------------------------

class TestTool extends Tool {
  readonly name = "test";
  readonly description = "Test tool";
  readonly parameters = {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1, maximum: 100 },
      ratio: { type: "number" },
      name: { type: "string", minLength: 1, maxLength: 50 },
      active: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      mode: { type: "string", enum: ["fast", "slow"] },
      opts: {
        type: "object",
        properties: { verbose: { type: "boolean" } },
        required: ["verbose"],
      },
    },
    required: ["count", "name"],
  };
  async execute(_p: Record<string, unknown>): Promise<unknown> { return "ok"; }
}

describe("Tool.castParams", () => {
  const tool = new TestTool();

  it("casts string integer to number", () => {
    const result = tool.castParams({ count: "42", name: "x" });
    expect(result["count"]).toBe(42);
  });

  it("casts string float to number for ratio", () => {
    const result = tool.castParams({ count: 1, name: "x", ratio: "3.14" });
    expect(result["ratio"]).toBe(3.14);
  });

  it("casts 'true' string to boolean", () => {
    const result = tool.castParams({ count: 1, name: "x", active: "true" });
    expect(result["active"]).toBe(true);
  });

  it("casts 'false' string to boolean", () => {
    const result = tool.castParams({ count: 1, name: "x", active: "false" });
    expect(result["active"]).toBe(false);
  });

  it("passes through valid integer unchanged", () => {
    const result = tool.castParams({ count: 5, name: "x" });
    expect(result["count"]).toBe(5);
  });

  it("casts array items", () => {
    const result = tool.castParams({ count: 1, name: "x", tags: [1, 2] });
    const tags = result["tags"] as string[];
    expect(tags[0]).toBe("1");
    expect(tags[1]).toBe("2");
  });
});

describe("Tool.validateParams", () => {
  const tool = new TestTool();

  it("passes for valid params", () => {
    const errors = tool.validateParams({ count: 5, name: "hello" });
    expect(errors).toHaveLength(0);
  });

  it("errors on missing required field", () => {
    const errors = tool.validateParams({ count: 5 }); // missing name
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("errors on wrong type", () => {
    const errors = tool.validateParams({ count: "not-a-number", name: "x" });
    expect(errors.some((e) => e.includes("integer"))).toBe(true);
  });

  it("errors on value below minimum", () => {
    const errors = tool.validateParams({ count: 0, name: "x" });
    expect(errors.some((e) => e.includes(">="))).toBe(true);
  });

  it("errors on value above maximum", () => {
    const errors = tool.validateParams({ count: 999, name: "x" });
    expect(errors.some((e) => e.includes("<="))).toBe(true);
  });

  it("errors on string below minLength", () => {
    const errors = tool.validateParams({ count: 1, name: "" });
    expect(errors.some((e) => e.includes("at least"))).toBe(true);
  });

  it("errors on string above maxLength", () => {
    const errors = tool.validateParams({ count: 1, name: "x".repeat(51) });
    expect(errors.some((e) => e.includes("at most"))).toBe(true);
  });

  it("errors on enum violation", () => {
    const errors = tool.validateParams({ count: 1, name: "x", mode: "invalid" });
    expect(errors.some((e) => e.includes("one of"))).toBe(true);
  });

  it("validates nested object required fields", () => {
    const errors = tool.validateParams({ count: 1, name: "x", opts: {} }); // missing verbose
    expect(errors.some((e) => e.includes("verbose"))).toBe(true);
  });

  it("validates array item types", () => {
    const errors = tool.validateParams({ count: 1, name: "x", tags: [123] });
    expect(errors.some((e) => e.includes("string"))).toBe(true);
  });

  it("returns error when params is not an object", () => {
    const errors = tool.validateParams("not-an-object" as unknown as Record<string, unknown>);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("Tool.toSchema", () => {
  it("returns schema with type, name, description", () => {
    const tool = new TestTool();
    const schema = tool.toSchema();
    expect(schema.type).toBe("function");
    expect(schema.function.name).toBe("test");
    expect(schema.function.description).toBe("Test tool");
    expect(schema.function.parameters).toBeDefined();
  });
});

describe("Tool getters — readOnly / concurrencySafe / exclusive", () => {
  it("default readOnly is false", () => {
    expect(new TestTool().readOnly).toBe(false);
  });

  it("concurrencySafe is false when readOnly is false", () => {
    expect(new TestTool().concurrencySafe).toBe(false);
  });

  it("ReadFileTool.readOnly is true", () => {
    expect(new ReadFileTool().readOnly).toBe(true);
  });

  it("ReadFileTool.concurrencySafe is true (readOnly and not exclusive)", () => {
    expect(new ReadFileTool().concurrencySafe).toBe(true);
  });

  it("default exclusive is false", () => {
    expect(new TestTool().exclusive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReadFileTool — extraAllowedDirs
// ---------------------------------------------------------------------------

describe("ReadFileTool — extraAllowedDirs", () => {
  const TMP2 = join(tmpdir(), "tarantul-extra-" + Date.now());
  const EXTRA_DIR = join(tmpdir(), "tarantul-extra-allowed-" + Date.now());

  it("allows reading from extraAllowedDirs even when restricted to workspace", async () => {
    mkdirSync(TMP2, { recursive: true });
    mkdirSync(EXTRA_DIR, { recursive: true });
    const extraFile = join(EXTRA_DIR, "skill.md");
    writeFileSync(extraFile, "skill content");

    const tool = new ReadFileTool(TMP2, TMP2, [EXTRA_DIR]);
    const result = await tool.execute({ path: extraFile });
    expect(String(result)).toContain("skill content");

    rmSync(TMP2, { recursive: true, force: true });
    rmSync(EXTRA_DIR, { recursive: true, force: true });
  });

  it("blocks reading outside both workspace and extraAllowedDirs", async () => {
    const ws = join(tmpdir(), "tarantul-ws-" + Date.now());
    const extra = join(tmpdir(), "tarantul-ex-" + Date.now());
    mkdirSync(ws, { recursive: true });
    mkdirSync(extra, { recursive: true });

    const tool = new ReadFileTool(ws, ws, [extra]);
    const result = await tool.execute({ path: "/etc/passwd" });
    expect(String(result)).toContain("outside allowed");

    rmSync(ws, { recursive: true, force: true });
    rmSync(extra, { recursive: true, force: true });
  });
});
