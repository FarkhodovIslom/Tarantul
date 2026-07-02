import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, relative, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { Tool } from "./base.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolvePath(
  path: string,
  workspace?: string | null,
  allowedDir?: string | null,
  extraAllowedDirs?: string[] | null,
): string {
  let p = path.startsWith("~/") ? path.replace("~", homedir()) : path;
  if (!p.startsWith("/") && workspace) {
    p = join(workspace, p);
  }
  const resolved = resolve(p);
  if (allowedDir) {
    const allowed = resolve(allowedDir);
    const inPrimary = resolved.startsWith(allowed + "/") || resolved === allowed;
    if (!inPrimary) {
      // Check extra allowed dirs (e.g. builtin skills)
      const inExtra = extraAllowedDirs?.some((dir) => {
        const a = resolve(dir);
        return resolved.startsWith(a + "/") || resolved === a;
      }) ?? false;
      if (!inExtra) {
        throw new Error(`Path ${path} is outside allowed directory ${allowedDir}`);
      }
    }
  }
  return resolved;
}

abstract class FsTool extends Tool {
  protected readonly workspace: string | null;
  protected readonly allowedDir: string | null;
  protected readonly extraAllowedDirs: string[] | null;

  constructor(workspace?: string | null, allowedDir?: string | null, extraAllowedDirs?: string[] | null) {
    super();
    this.workspace = workspace ?? null;
    this.allowedDir = allowedDir ?? null;
    this.extraAllowedDirs = extraAllowedDirs ?? null;
  }

  protected resolve(path: string): string {
    return resolvePath(path, this.workspace, this.allowedDir, this.extraAllowedDirs);
  }
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const MAX_CHARS = 128_000;
const DEFAULT_LIMIT = 2000;

export class ReadFileTool extends FsTool {
  override readonly name = "read_file";
  override get readOnly(): boolean { return true; }
  override readonly description =
    "Read the contents of a file. Returns numbered lines. " +
    "Use offset and limit to paginate through large files.";

  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "The file path to read" },
      offset: {
        type: "integer",
        description: "Line number to start reading from (1-indexed, default 1)",
        minimum: 1,
      },
      limit: {
        type: "integer",
        description: "Maximum number of lines to read (default 2000)",
        minimum: 1,
      },
    },
    required: ["path"],
  };

  async execute(params: Record<string, unknown>): Promise<unknown> {
    const path = params["path"] as string | undefined;
    const offset = Number(params["offset"] ?? 1);
    const limit = params["limit"] != null ? Number(params["limit"]) : null;

    try {
      if (!path) return "Error reading file: Unknown path";
      const fp = this.resolve(path);
      if (!existsSync(fp)) return `Error: File not found: ${path}`;
      if (!statSync(fp).isFile()) return `Error: Not a file: ${path}`;

      const raw = readFileSync(fp);
      if (!raw.length) return `(Empty file: ${path})`;

      // Image detection
      const mime = detectImageMime(raw);
      if (mime) {
        return buildImageContentBlocks(raw, mime, fp, `(Image file: ${path})`);
      }

      let text: string;
      try {
        text = raw.toString("utf-8");
      } catch {
        return `Error: Cannot read binary file ${path}. Only UTF-8 text and images are supported.`;
      }

      const allLines = text.split("\n");
      const total = allLines.length;
      let effectiveOffset = Math.max(1, offset);
      if (effectiveOffset > total) return `Error: offset ${offset} is beyond end of file (${total} lines)`;

      const start = effectiveOffset - 1;
      const end = Math.min(start + (limit ?? DEFAULT_LIMIT), total);
      const slice = allLines.slice(start, end);
      let numbered = slice.map((line, i) => `${start + i + 1}| ${line}`);
      let result = numbered.join("\n");

      if (result.length > MAX_CHARS) {
        const trimmed: string[] = [];
        let chars = 0;
        for (const line of numbered) {
          chars += line.length + 1;
          if (chars > MAX_CHARS) break;
          trimmed.push(line);
        }
        numbered = trimmed;
        result = trimmed.join("\n");
      }

      const shownEnd = start + numbered.length;
      if (shownEnd < total) {
        result += `\n\n(Showing lines ${effectiveOffset}-${shownEnd} of ${total}. Use offset=${shownEnd + 1} to continue.)`;
      } else {
        result += `\n\n(End of file — ${total} lines total)`;
      }
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.includes("outside allowed")) return `Error: ${err.message}`;
      return `Error reading file: ${err}`;
    }
  }
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export class WriteFileTool extends FsTool {
  readonly name = "write_file";
  readonly description = "Write content to a file at the given path. Creates parent directories if needed.";

  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "The file path to write to" },
      content: { type: "string", description: "The content to write" },
    },
    required: ["path", "content"],
  };

  async execute(params: Record<string, unknown>): Promise<string> {
    const path = params["path"] as string | undefined;
    const content = params["content"] as string | undefined;
    try {
      if (!path) throw new Error("Unknown path");
      if (content == null) throw new Error("Unknown content");
      const fp = this.resolve(path);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content, "utf-8");
      return `Successfully wrote ${content.length} bytes to ${fp}`;
    } catch (err) {
      if (err instanceof Error && err.message.includes("outside allowed")) return `Error: ${err.message}`;
      return `Error writing file: ${err}`;
    }
  }
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

function findMatch(content: string, oldText: string): { match: string | null; count: number } {
  if (content.includes(oldText)) {
    return { match: oldText, count: (content.split(oldText).length - 1) };
  }

  const oldLines = oldText.split("\n");
  if (oldLines.length === 0) return { match: null, count: 0 };
  const strippedOld = oldLines.map((l) => l.trim());
  const contentLines = content.split("\n");

  const candidates: string[] = [];
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const window = contentLines.slice(i, i + oldLines.length);
    if (window.map((l) => l.trim()).join("\n") === strippedOld.join("\n")) {
      candidates.push(window.join("\n"));
    }
  }

  if (candidates.length > 0) return { match: candidates[0]!, count: candidates.length };
  return { match: null, count: 0 };
}

export class EditFileTool extends FsTool {
  readonly name = "edit_file";
  readonly description =
    "Edit a file by replacing old_text with new_text. " +
    "Supports minor whitespace/line-ending differences. " +
    "Set replace_all=true to replace every occurrence.";

  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "The file path to edit" },
      old_text: { type: "string", description: "The text to find and replace" },
      new_text: { type: "string", description: "The text to replace with" },
      replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
    },
    required: ["path", "old_text", "new_text"],
  };

  async execute(params: Record<string, unknown>): Promise<string> {
    const path = params["path"] as string | undefined;
    const oldText = params["old_text"] as string | undefined;
    const newText = params["new_text"] as string | undefined;
    const replaceAll = Boolean(params["replace_all"] ?? false);

    try {
      if (!path) throw new Error("Unknown path");
      if (oldText == null) throw new Error("Unknown old_text");
      if (newText == null) throw new Error("Unknown new_text");

      const fp = this.resolve(path);
      if (!existsSync(fp)) return `Error: File not found: ${path}`;

      const raw = readFileSync(fp);
      const usesCrlf = raw.includes("\r\n" as unknown as number);
      const content = raw.toString("utf-8").replace(/\r\n/g, "\n");
      const { match, count } = findMatch(content, oldText.replace(/\r\n/g, "\n"));

      if (match === null) {
        return `Error: old_text not found in ${path}. Verify the file content.`;
      }
      if (count > 1 && !replaceAll) {
        return (
          `Warning: old_text appears ${count} times. ` +
          "Provide more context to make it unique, or set replace_all=true."
        );
      }

      const normNew = newText.replace(/\r\n/g, "\n");
      let newContent: string;
      if (replaceAll) {
        newContent = content.split(match).join(normNew);
      } else {
        const idx = content.indexOf(match);
        newContent = content.slice(0, idx) + normNew + content.slice(idx + match.length);
      }
      if (usesCrlf) newContent = newContent.replace(/\n/g, "\r\n");

      writeFileSync(fp, newContent, "utf-8");
      return `Successfully edited ${fp}`;
    } catch (err) {
      if (err instanceof Error && err.message.includes("outside allowed")) return `Error: ${err.message}`;
      return `Error editing file: ${err}`;
    }
  }
}

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

const DEFAULT_MAX = 200;
const IGNORE_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv",
  "dist", "build", ".tox", ".mypy_cache", ".pytest_cache",
  ".ruff_cache", ".coverage", "htmlcov",
]);

export class ListDirTool extends FsTool {
  override readonly name = "list_dir";
  override get readOnly(): boolean { return true; }
  override readonly description =
    "List the contents of a directory. " +
    "Set recursive=true to explore nested structure. " +
    "Common noise directories (.git, node_modules, __pycache__, etc.) are auto-ignored.";

  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "The directory path to list" },
      recursive: { type: "boolean", description: "Recursively list all files (default false)" },
      max_entries: {
        type: "integer",
        description: "Maximum entries to return (default 200)",
        minimum: 1,
      },
    },
    required: ["path"],
  };

  async execute(params: Record<string, unknown>): Promise<string> {
    const path = params["path"] as string | undefined;
    const recursive = Boolean(params["recursive"] ?? false);
    const maxEntries = Number(params["max_entries"] ?? DEFAULT_MAX);

    try {
      if (path == null) throw new Error("Unknown path");
      const dp = this.resolve(path);
      if (!existsSync(dp)) return `Error: Directory not found: ${path}`;
      if (!statSync(dp).isDirectory()) return `Error: Not a directory: ${path}`;

      const items: string[] = [];
      let total = 0;

      if (recursive) {
        const state = { total: 0, cap: maxEntries };
        collectRecursive(dp, dp, items, state);
        total = state.total;
      } else {
        const entries = readdirSync(dp).sort();
        for (const name of entries) {
          if (IGNORE_DIRS.has(name)) continue;
          total++;
          if (items.length < maxEntries) {
            const isDir = statSync(join(dp, name)).isDirectory();
            items.push(`${isDir ? "📁 " : "📄 "}${name}`);
          }
        }
      }

      if (items.length === 0 && total === 0) return `Directory ${path} is empty`;

      let result = items.join("\n");
      if (total > maxEntries) {
        result += `\n\n(truncated, showing first ${maxEntries} of ${total} entries)`;
      }
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.includes("outside allowed")) return `Error: ${err.message}`;
      return `Error listing directory: ${err}`;
    }
  }
}

function collectRecursive(
  root: string,
  dir: string,
  items: string[],
  state: { total: number; cap: number },
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const rel = relative(root, full);
    const parts = rel.split("/");
    if (parts.some((p) => IGNORE_DIRS.has(p))) continue;
    state.total++;
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    if (items.length < state.cap) items.push(isDir ? `${rel}/` : rel);
    if (isDir) collectRecursive(root, full, items, state);
  }
}

// ---------------------------------------------------------------------------
// Image detection helpers (lightweight, no external deps)
// ---------------------------------------------------------------------------

const IMAGE_MAGIC: Array<{ bytes: Buffer; mime: string }> = [
  { bytes: Buffer.from([0xff, 0xd8, 0xff]), mime: "image/jpeg" },
  { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: "image/png" },
  { bytes: Buffer.from([0x47, 0x49, 0x46]), mime: "image/gif" },
  { bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]), mime: "image/webp" },
];

function detectImageMime(buf: Buffer): string | null {
  for (const { bytes, mime } of IMAGE_MAGIC) {
    if (buf.slice(0, bytes.length).equals(bytes)) return mime;
  }
  // WebP check (RIFF....WEBP)
  if (buf.length >= 12 && buf.slice(0, 4).equals(Buffer.from("RIFF")) && buf.slice(8, 12).equals(Buffer.from("WEBP"))) {
    return "image/webp";
  }
  return null;
}

function buildImageContentBlocks(
  buf: Buffer,
  mime: string,
  _path: string,
  fallback: string,
): unknown[] | string {
  try {
    const b64 = buf.toString("base64");
    return [{ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }];
  } catch {
    return fallback;
  }
}
