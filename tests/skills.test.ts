/**
 * Tests for the skills system (Phase 10).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillsLoader } from "../src/skills/loader.js";
import { BUILTIN_SKILLS_DIR } from "../src/skills/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tarantul-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkill(base: string, name: string, content: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, content);
  return file;
}

const SIMPLE_SKILL = `---
name: test-skill
description: A test skill for unit testing.
---

# Test Skill

This skill does things for testing.
`;

const ALWAYS_SKILL = `---
name: always-skill
description: Always-loaded skill.
metadata: {"tarantul":{"always":true}}
---

# Always Skill

This is always in context.
`;

const REQUIRES_SKILL = `---
name: requires-bins
description: Skill that needs a fake binary.
metadata: {"tarantul":{"requires":{"bins":["__nonexistent_bin_xyz__"]}}}
---

# Requires Bins

This skill needs a binary.
`;

const ENV_SKILL = `---
name: requires-env
description: Skill that needs an env var.
metadata: {"tarantul":{"requires":{"env":["__NONEXISTENT_ENV_XYZ__"]}}}
---

# Requires Env

This skill needs an env var.
`;

const MULTI_FIELD_SKILL = `---
name: github
description: "Interact with GitHub using the \`gh\` CLI."
metadata: {"tarantul":{"emoji":"🐙","requires":{"bins":["gh"]}}}
---

# GitHub Skill

Use gh commands here.
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillsLoader — constructor + discovery", () => {
  let wsDir: string;
  let builtinDir: string;

  beforeEach(() => {
    wsDir = makeTmpDir();
    builtinDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(builtinDir, { recursive: true, force: true });
  });

  it("lists no skills for empty workspace and empty builtin dir", () => {
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.listSkills(false)).toEqual([]);
  });

  it("lists skills from builtin dir", () => {
    writeSkill(builtinDir, "test-skill", SIMPLE_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    const skills = loader.listSkills(false);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("test-skill");
    expect(skills[0]!.source).toBe("builtin");
  });

  it("lists skills from workspace dir", () => {
    const wsSkillsDir = join(wsDir, "skills");
    mkdirSync(wsSkillsDir, { recursive: true });
    writeSkill(wsSkillsDir, "ws-skill", SIMPLE_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    const skills = loader.listSkills(false);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("ws-skill");
    expect(skills[0]!.source).toBe("workspace");
  });

  it("workspace skills take priority over builtin with same name", () => {
    writeSkill(builtinDir, "my-skill", SIMPLE_SKILL);
    const wsSkillsDir = join(wsDir, "skills");
    mkdirSync(wsSkillsDir, { recursive: true });
    writeSkill(wsSkillsDir, "my-skill", `---\nname: my-skill\ndescription: Workspace version.\n---\n`);
    const loader = new SkillsLoader(wsDir, builtinDir);
    const skills = loader.listSkills(false);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.source).toBe("workspace");
  });

  it("ignores directories without SKILL.md", () => {
    mkdirSync(join(builtinDir, "not-a-skill"), { recursive: true });
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.listSkills(false)).toHaveLength(0);
  });
});

describe("SkillsLoader — loadSkill", () => {
  let wsDir: string;
  let builtinDir: string;

  beforeEach(() => {
    wsDir = makeTmpDir();
    builtinDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(builtinDir, { recursive: true, force: true });
  });

  it("returns null for unknown skill", () => {
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.loadSkill("no-such-skill")).toBeNull();
  });

  it("loads skill content from builtin dir", () => {
    writeSkill(builtinDir, "test-skill", SIMPLE_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    const content = loader.loadSkill("test-skill");
    expect(content).toContain("A test skill");
  });

  it("workspace skill overrides builtin", () => {
    writeSkill(builtinDir, "my-skill", "---\nname: my-skill\ndescription: Builtin version.\n---\n# Builtin");
    const wsSkillsDir = join(wsDir, "skills");
    mkdirSync(wsSkillsDir, { recursive: true });
    writeSkill(wsSkillsDir, "my-skill", "---\nname: my-skill\ndescription: Workspace version.\n---\n# Workspace");
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.loadSkill("my-skill")).toContain("# Workspace");
  });
});

describe("SkillsLoader — getSkillMetadata", () => {
  let wsDir: string;
  let builtinDir: string;

  beforeEach(() => {
    wsDir = makeTmpDir();
    builtinDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(builtinDir, { recursive: true, force: true });
  });

  it("returns null for unknown skill", () => {
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.getSkillMetadata("nope")).toBeNull();
  });

  it("parses frontmatter fields", () => {
    writeSkill(builtinDir, "test", SIMPLE_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    const meta = loader.getSkillMetadata("test");
    expect(meta).not.toBeNull();
    expect(meta!["name"]).toBe("test-skill");
    expect(meta!["description"]).toBe("A test skill for unit testing.");
  });
});

describe("SkillsLoader — requirements filtering", () => {
  let wsDir: string;
  let builtinDir: string;

  beforeEach(() => {
    wsDir = makeTmpDir();
    builtinDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(builtinDir, { recursive: true, force: true });
  });

  it("includes skills with no requirements", () => {
    writeSkill(builtinDir, "simple", SIMPLE_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.listSkills(true)).toHaveLength(1);
  });

  it("filters out skills with missing binary", () => {
    writeSkill(builtinDir, "req-bins", REQUIRES_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.listSkills(true)).toHaveLength(0);
    expect(loader.listSkills(false)).toHaveLength(1);
  });

  it("filters out skills with missing env var", () => {
    writeSkill(builtinDir, "req-env", ENV_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.listSkills(true)).toHaveLength(0);
  });
});

describe("SkillsLoader — getAlwaysSkills", () => {
  let wsDir: string;
  let builtinDir: string;

  beforeEach(() => {
    wsDir = makeTmpDir();
    builtinDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(builtinDir, { recursive: true, force: true });
  });

  it("returns empty array when no always skills", () => {
    writeSkill(builtinDir, "simple", SIMPLE_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.getAlwaysSkills()).toEqual([]);
  });

  it("returns skills marked always=true", () => {
    writeSkill(builtinDir, "always-skill", ALWAYS_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.getAlwaysSkills()).toEqual(["always-skill"]);
  });

  it("does not include always skills with unmet requirements", () => {
    const content = `---\nname: always-req\ndescription: Always but needs binary.\nmetadata: {"tarantul":{"always":true,"requires":{"bins":["__nonexistent__"]}}}\n---\n# content`;
    writeSkill(builtinDir, "always-req", content);
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.getAlwaysSkills()).toEqual([]);
  });
});

describe("SkillsLoader — loadSkillsForContext", () => {
  let wsDir: string;
  let builtinDir: string;

  beforeEach(() => {
    wsDir = makeTmpDir();
    builtinDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(builtinDir, { recursive: true, force: true });
  });

  it("returns empty string for empty list", () => {
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.loadSkillsForContext([])).toBe("");
  });

  it("strips frontmatter from content", () => {
    writeSkill(builtinDir, "test", SIMPLE_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    const result = loader.loadSkillsForContext(["test"]);
    expect(result).not.toContain("---");
    expect(result).toContain("# Test Skill");
    expect(result).toContain("### Skill: test");
  });

  it("separates multiple skills with ---", () => {
    writeSkill(builtinDir, "skill-a", SIMPLE_SKILL);
    writeSkill(builtinDir, "skill-b", ALWAYS_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    const result = loader.loadSkillsForContext(["skill-a", "skill-b"]);
    expect(result).toContain("---");
    expect(result).toContain("### Skill: skill-a");
    expect(result).toContain("### Skill: skill-b");
  });

  it("skips unknown skill names", () => {
    writeSkill(builtinDir, "real", SIMPLE_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    const result = loader.loadSkillsForContext(["real", "nonexistent"]);
    expect(result).toContain("### Skill: real");
    expect(result).not.toContain("nonexistent");
  });
});

describe("SkillsLoader — buildSkillsSummary", () => {
  let wsDir: string;
  let builtinDir: string;

  beforeEach(() => {
    wsDir = makeTmpDir();
    builtinDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(builtinDir, { recursive: true, force: true });
  });

  it("returns empty string when no skills", () => {
    const loader = new SkillsLoader(wsDir, builtinDir);
    expect(loader.buildSkillsSummary()).toBe("");
  });

  it("generates valid XML with skill entry", () => {
    writeSkill(builtinDir, "test", SIMPLE_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    const xml = loader.buildSkillsSummary();
    expect(xml).toContain("<skills>");
    expect(xml).toContain("</skills>");
    expect(xml).toContain("<name>test</name>");
    expect(xml).toContain("A test skill");
    expect(xml).toContain('available="true"');
  });

  it("marks unavailable skills correctly", () => {
    writeSkill(builtinDir, "needs-bin", REQUIRES_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    const xml = loader.buildSkillsSummary();
    expect(xml).toContain('available="false"');
    expect(xml).toContain("<requires>");
    expect(xml).toContain("CLI: __nonexistent_bin_xyz__");
  });

  it("includes <location> pointing to SKILL.md path", () => {
    writeSkill(builtinDir, "test", SIMPLE_SKILL);
    const loader = new SkillsLoader(wsDir, builtinDir);
    const xml = loader.buildSkillsSummary();
    expect(xml).toContain("<location>");
    expect(xml).toContain("SKILL.md");
  });

  it("XML-escapes special characters in description", () => {
    const content = `---\nname: tricky\ndescription: Has <angle> & "quotes".\n---\n# Tricky\n`;
    writeSkill(builtinDir, "tricky", content);
    const loader = new SkillsLoader(wsDir, builtinDir);
    const xml = loader.buildSkillsSummary();
    expect(xml).toContain("&lt;angle&gt;");
    expect(xml).toContain("&amp;");
  });
});

describe("BUILTIN_SKILLS_DIR — bundled skills", () => {
  it("points to a directory that exists", () => {
    expect(existsSync(BUILTIN_SKILLS_DIR)).toBe(true);
  });

  it("contains at least the memory skill", () => {
    const memSkill = join(BUILTIN_SKILLS_DIR, "memory", "SKILL.md");
    expect(existsSync(memSkill)).toBe(true);
  });

  it("can load builtin skills without errors", () => {
    const wsDir = makeTmpDir();
    try {
      const loader = new SkillsLoader(wsDir);
      const allSkills = loader.listSkills(false);
      expect(allSkills.length).toBeGreaterThan(0);
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it("memory skill is always-loaded", () => {
    const wsDir = makeTmpDir();
    try {
      const loader = new SkillsLoader(wsDir);
      const always = loader.getAlwaysSkills();
      // memory skill should be always=true and has no binary requirements
      expect(always).toContain("memory");
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });
});
