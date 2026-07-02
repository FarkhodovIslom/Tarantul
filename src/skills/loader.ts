/**
 * Skills are subdirectories containing a SKILL.md file with YAML frontmatter:
 *   name        — hyphen-case identifier
 *   description — what the skill does (used in summary)
 *   metadata    — JSON blob with tarantul key (requires, always, emoji, install)
 *   always      — top-level boolean shorthand for always-load
 *
 * Two discovery paths (workspace takes priority over builtin):
 *   <workspace>/skills/<name>/SKILL.md
 *   <builtinSkillsDir>/<name>/SKILL.md
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Absolute path to bundled builtin skills (project-root/skills/). */
export const BUILTIN_SKILLS_DIR = resolve(import.meta.dir, "../../skills");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillInfo {
  name: string;
  path: string;
  source: "workspace" | "builtin";
}

export interface TarantulSkillMeta {
  emoji?: string;
  requires?: { bins?: string[]; env?: string[] };
  install?: unknown[];
  always?: boolean;
  os?: string[];
}

// ---------------------------------------------------------------------------
// SkillsLoader
// ---------------------------------------------------------------------------

export class SkillsLoader {
  private readonly workspaceSkillsDir: string;

  constructor(
    private readonly workspace: string,
    private readonly builtinSkillsDir: string = BUILTIN_SKILLS_DIR,
  ) {
    this.workspaceSkillsDir = join(workspace, "skills");
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * List all discovered skills.
   * @param filterUnavailable — if true, omit skills with unmet requirements.
   */
  listSkills(filterUnavailable = true): SkillInfo[] {
    const skills: SkillInfo[] = [];

    // Workspace skills take priority
    if (existsSync(this.workspaceSkillsDir)) {
      for (const entry of safeReaddir(this.workspaceSkillsDir)) {
        const skillFile = join(this.workspaceSkillsDir, entry, "SKILL.md");
        if (existsSync(skillFile) && isDir(join(this.workspaceSkillsDir, entry))) {
          skills.push({ name: entry, path: skillFile, source: "workspace" });
        }
      }
    }

    // Builtin skills (skip if workspace already has same name)
    if (existsSync(this.builtinSkillsDir)) {
      for (const entry of safeReaddir(this.builtinSkillsDir)) {
        const skillFile = join(this.builtinSkillsDir, entry, "SKILL.md");
        if (
          existsSync(skillFile) &&
          isDir(join(this.builtinSkillsDir, entry)) &&
          !skills.some((s) => s.name === entry)
        ) {
          skills.push({ name: entry, path: skillFile, source: "builtin" });
        }
      }
    }

    if (!filterUnavailable) return skills;
    return skills.filter((s) => this._checkRequirements(this._getTarantulMeta(s.name)));
  }

  /** Load the raw content of a skill's SKILL.md by name. */
  loadSkill(name: string): string | null {
    const wsFile = join(this.workspaceSkillsDir, name, "SKILL.md");
    if (existsSync(wsFile)) return safeRead(wsFile);

    const builtinFile = join(this.builtinSkillsDir, name, "SKILL.md");
    if (existsSync(builtinFile)) return safeRead(builtinFile);

    return null;
  }

  /**
   * Load multiple skills, stripped of frontmatter, formatted for context.
   * Returns empty string if no skills found.
   */
  loadSkillsForContext(skillNames: string[]): string {
    const parts: string[] = [];
    for (const name of skillNames) {
      const content = this.loadSkill(name);
      if (content) {
        parts.push(`### Skill: ${name}\n\n${this._stripFrontmatter(content)}`);
      }
    }
    return parts.join("\n\n---\n\n");
  }

  /**
   * Build an XML summary of all skills (including unavailable ones).
   * Used for progressive loading — agent reads full SKILL.md on-demand.
   */
  buildSkillsSummary(): string {
    const allSkills = this.listSkills(false);
    if (allSkills.length === 0) return "";

    const lines: string[] = ["<skills>"];
    for (const s of allSkills) {
      const name = escapeXml(s.name);
      const desc = escapeXml(this._getSkillDescription(s.name));
      const meta = this._getTarantulMeta(s.name);
      const available = this._checkRequirements(meta);

      lines.push(`  <skill available="${available ? "true" : "false"}">`);
      lines.push(`    <name>${name}</name>`);
      lines.push(`    <description>${desc}</description>`);
      lines.push(`    <location>${s.path}</location>`);

      if (!available) {
        const missing = this._getMissingRequirements(meta);
        if (missing) lines.push(`    <requires>${escapeXml(missing)}</requires>`);
      }

      lines.push("  </skill>");
    }
    lines.push("</skills>");
    return lines.join("\n");
  }

  /** Return names of skills that are always-loaded (and have met requirements). */
  getAlwaysSkills(): string[] {
    return this.listSkills(true)
      .filter((s) => {
        const meta = this.getSkillMetadata(s.name) ?? {};
        const nbMeta = this._getTarantulMeta(s.name);
        return nbMeta.always === true || meta["always"] === "true";
      })
      .map((s) => s.name);
  }

  /**
   * Parse the YAML frontmatter of a skill and return it as a flat key→value map.
   * Only parses simple `key: value` lines (no nested YAML).
   */
  getSkillMetadata(name: string): Record<string, string> | null {
    const content = this.loadSkill(name);
    if (!content) return null;

    if (content.startsWith("---")) {
      const match = /^---\n([\s\S]*?)\n---/.exec(content);
      if (match) {
        const meta: Record<string, string> = {};
        for (const line of match[1]!.split("\n")) {
          const colonIdx = line.indexOf(":");
          if (colonIdx > 0) {
            const key = line.slice(0, colonIdx).trim();
            const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
            meta[key] = value;
          }
        }
        return meta;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _checkRequirements(meta: TarantulSkillMeta): boolean {
    const req = meta.requires ?? {};
    for (const bin of req.bins ?? []) {
      if (!Bun.which(bin)) return false;
    }
    for (const env of req.env ?? []) {
      if (!process.env[env]) return false;
    }
    return true;
  }

  private _getMissingRequirements(meta: TarantulSkillMeta): string {
    const missing: string[] = [];
    const req = meta.requires ?? {};
    for (const bin of req.bins ?? []) {
      if (!Bun.which(bin)) missing.push(`CLI: ${bin}`);
    }
    for (const env of req.env ?? []) {
      if (!process.env[env]) missing.push(`ENV: ${env}`);
    }
    return missing.join(", ");
  }

  private _getTarantulMeta(name: string): TarantulSkillMeta {
    const raw = this.getSkillMetadata(name);
    if (!raw) return {};
    return this._parseTarantulMetadata(raw["metadata"] ?? "");
  }

  private _parseTarantulMetadata(raw: string): TarantulSkillMeta {
    if (!raw) return {};
    try {
      const data = JSON.parse(raw) as unknown;
      if (typeof data !== "object" || data === null) return {};
      const obj = data as Record<string, unknown>;
      const nb = obj["tarantul"] ?? obj["nanobot"] ?? obj["openclaw"];
      if (typeof nb === "object" && nb !== null) return nb as TarantulSkillMeta;
      return {};
    } catch {
      return {};
    }
  }

  private _getSkillDescription(name: string): string {
    const meta = this.getSkillMetadata(name);
    return meta?.["description"] ?? name;
  }

  private _stripFrontmatter(content: string): string {
    if (!content.startsWith("---")) return content;
    const match = /^---\n[\s\S]*?\n---\n/.exec(content);
    if (match) return content.slice(match[0].length).trimStart();
    return content;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function safeRead(path: string): string | null {
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
