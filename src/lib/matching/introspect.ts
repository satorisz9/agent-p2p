/**
 * WorkspaceIntrospector — auto-detects agent skills from the workspace.
 *
 * Sources:
 *   1. package.json → JS/TS frameworks & libraries
 *   2. requirements.txt → Python packages
 *   3. File existence → Dockerfile, Cargo.toml, go.mod, *.tf, etc.
 *   4. MCP server list → tool capabilities (external call)
 *
 * All methods are static and pure (no side effects) for easy testing.
 * The `scanDirectory` method is the only one that reads the filesystem.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { SkillEntry, SkillLevel, CapabilityTier } from "../../types/protocol";

/** Mapping from npm package name (or pattern) to skill */
const NPM_SKILL_MAP: Record<string, { domain: string; skill: string }> = {
  typescript: { domain: "coding", skill: "typescript" },
  react: { domain: "coding", skill: "react" },
  "react-dom": { domain: "coding", skill: "react" },
  "react-native": { domain: "coding", skill: "react-native" },
  next: { domain: "coding", skill: "nextjs" },
  vue: { domain: "coding", skill: "vue" },
  nuxt: { domain: "coding", skill: "nuxt" },
  angular: { domain: "coding", skill: "angular" },
  express: { domain: "coding", skill: "express" },
  fastify: { domain: "coding", skill: "fastify" },
  nestjs: { domain: "coding", skill: "nestjs" },
  "@nestjs/core": { domain: "coding", skill: "nestjs" },
  prisma: { domain: "data", skill: "prisma" },
  "@prisma/client": { domain: "data", skill: "prisma" },
  sequelize: { domain: "data", skill: "postgresql" },
  pg: { domain: "data", skill: "postgresql" },
  mysql2: { domain: "data", skill: "mysql" },
  mongodb: { domain: "data", skill: "mongodb" },
  mongoose: { domain: "data", skill: "mongodb" },
  redis: { domain: "data", skill: "redis" },
  ioredis: { domain: "data", skill: "redis" },
  tensorflow: { domain: "data", skill: "tensorflow" },
  "@tensorflow/tfjs": { domain: "data", skill: "tensorflow" },
  "@modelcontextprotocol/sdk": { domain: "infra", skill: "mcp" },
  hyperswarm: { domain: "infra", skill: "p2p" },
  ethers: { domain: "coding", skill: "ethereum" },
  web3: { domain: "coding", skill: "ethereum" },
  "@solana/web3.js": { domain: "coding", skill: "solana" },
  tailwindcss: { domain: "design", skill: "tailwind" },
};

/** Python package → skill mapping */
const PY_SKILL_MAP: Record<string, { domain: string; skill: string }> = {
  fastapi: { domain: "coding", skill: "fastapi" },
  django: { domain: "coding", skill: "django" },
  flask: { domain: "coding", skill: "flask" },
  torch: { domain: "data", skill: "pytorch" },
  pytorch: { domain: "data", skill: "pytorch" },
  tensorflow: { domain: "data", skill: "tensorflow" },
  numpy: { domain: "data", skill: "numpy" },
  pandas: { domain: "data", skill: "pandas" },
  scikit: { domain: "data", skill: "sklearn" },
  "scikit-learn": { domain: "data", skill: "sklearn" },
  sqlalchemy: { domain: "data", skill: "postgresql" },
  psycopg2: { domain: "data", skill: "postgresql" },
  boto3: { domain: "infra", skill: "aws" },
  kubernetes: { domain: "devops", skill: "kubernetes" },
  ansible: { domain: "devops", skill: "ansible" },
};

/** File/directory patterns → skill */
const FILE_SKILL_MAP: { pattern: string | RegExp; domain: string; skill: string }[] = [
  { pattern: "Dockerfile", domain: "devops", skill: "docker" },
  { pattern: "docker-compose.yml", domain: "devops", skill: "docker" },
  { pattern: "docker-compose.yaml", domain: "devops", skill: "docker" },
  { pattern: "Cargo.toml", domain: "coding", skill: "rust" },
  { pattern: "go.mod", domain: "coding", skill: "go" },
  { pattern: /\.tf$/, domain: "devops", skill: "terraform" },
  { pattern: "kubernetes", domain: "devops", skill: "kubernetes" },
  { pattern: "k8s", domain: "devops", skill: "kubernetes" },
  { pattern: ".github/workflows", domain: "devops", skill: "github-actions" },
  { pattern: ".gitlab-ci.yml", domain: "devops", skill: "gitlab-ci" },
  { pattern: "Makefile", domain: "devops", skill: "make" },
  { pattern: "setup.py", domain: "coding", skill: "python" },
  { pattern: "pyproject.toml", domain: "coding", skill: "python" },
  { pattern: "requirements.txt", domain: "coding", skill: "python" },
  { pattern: "Gemfile", domain: "coding", skill: "ruby" },
];

/** Model name → capability tier */
const MODEL_TIERS: Record<string, CapabilityTier> = {
  "claude-opus-4-6": "high",
  "claude-opus-4-5-20250514": "high",
  "claude-sonnet-4-6": "mid",
  "claude-sonnet-4-5-20250514": "mid",
  "claude-haiku-4-5-20251001": "light",
  "gpt-5.4": "high",
  "gpt-4.1": "mid",
  "gpt-4.1-mini": "light",
  "o3": "high",
  "o4-mini": "mid",
};

export class WorkspaceIntrospector {
  /**
   * Parse package.json object and extract skills.
   * Public and static for testability (no filesystem access).
   */
  static parsePackageJson(pkg: Record<string, any>): SkillEntry[] {
    const seen = new Set<string>();
    const skills: SkillEntry[] = [];

    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    for (const dep of Object.keys(allDeps)) {
      const mapping = NPM_SKILL_MAP[dep];
      if (mapping && !seen.has(mapping.skill)) {
        seen.add(mapping.skill);
        skills.push({ domain: mapping.domain, skill: mapping.skill, level: 2 });
      }
    }

    // Always add nodejs/javascript if there's a package.json with deps
    if (Object.keys(allDeps).length > 0 && !seen.has("nodejs")) {
      skills.push({ domain: "coding", skill: "nodejs", level: 2 });
    }

    return skills;
  }

  /**
   * Parse requirements.txt content and extract skills.
   */
  static parseRequirementsTxt(content: string): SkillEntry[] {
    const seen = new Set<string>();
    const skills: SkillEntry[] = [];
    let hasPythonPkg = false;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Extract package name (before ==, >=, ~=, etc.)
      const pkgName = trimmed.split(/[>=<!~\[]/)[0].trim().toLowerCase();
      if (!pkgName) continue;

      hasPythonPkg = true;

      const mapping = PY_SKILL_MAP[pkgName];
      if (mapping && !seen.has(mapping.skill)) {
        seen.add(mapping.skill);
        skills.push({ domain: mapping.domain, skill: mapping.skill, level: 2 });
      }
    }

    // Always add python if we found any packages
    if (hasPythonPkg && !seen.has("python")) {
      skills.push({ domain: "coding", skill: "python", level: 2 });
    }

    return skills;
  }

  /**
   * Detect skills from a list of file/directory names present in the workspace root.
   */
  static detectFromFiles(files: string[]): SkillEntry[] {
    const seen = new Set<string>();
    const skills: SkillEntry[] = [];

    for (const file of files) {
      for (const mapping of FILE_SKILL_MAP) {
        if (seen.has(mapping.skill)) continue;

        if (typeof mapping.pattern === "string") {
          if (file === mapping.pattern || file.includes(mapping.pattern)) {
            seen.add(mapping.skill);
            skills.push({ domain: mapping.domain, skill: mapping.skill, level: 2 });
          }
        } else if (mapping.pattern.test(file)) {
          seen.add(mapping.skill);
          skills.push({ domain: mapping.domain, skill: mapping.skill, level: 2 });
        }
      }
    }

    return skills;
  }

  /**
   * Resolve a model name string to a capability tier.
   */
  static getCapabilityTier(modelName?: string): CapabilityTier | undefined {
    if (!modelName) return undefined;
    // Try exact match first, then prefix match
    if (MODEL_TIERS[modelName]) return MODEL_TIERS[modelName];
    for (const [key, tier] of Object.entries(MODEL_TIERS)) {
      if (modelName.startsWith(key)) return tier;
    }
    return undefined;
  }

  /**
   * Scan an actual directory and return detected skills.
   * This is the main entry point for real usage.
   */
  static scanDirectory(dir: string): SkillEntry[] {
    const allSkills: SkillEntry[] = [];
    const seen = new Set<string>();

    const addUnique = (skills: SkillEntry[]) => {
      for (const s of skills) {
        const key = `${s.domain}:${s.skill}`;
        if (!seen.has(key)) {
          seen.add(key);
          allSkills.push(s);
        }
      }
    };

    // List top-level files
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      return [];
    }

    // 1. File-based detection
    addUnique(WorkspaceIntrospector.detectFromFiles(files));

    // 2. package.json
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        addUnique(WorkspaceIntrospector.parsePackageJson(pkg));
      } catch { /* skip malformed */ }
    }

    // 3. requirements.txt
    const reqPath = join(dir, "requirements.txt");
    if (existsSync(reqPath)) {
      try {
        const content = readFileSync(reqPath, "utf8");
        addUnique(WorkspaceIntrospector.parseRequirementsTxt(content));
      } catch { /* skip */ }
    }

    // 4. Check .github/workflows for CI
    const ghWorkflows = join(dir, ".github", "workflows");
    if (existsSync(ghWorkflows)) {
      addUnique([{ domain: "devops", skill: "github-actions", level: 2 }]);
    }

    return allSkills;
  }
}
