#!/usr/bin/env node
/**
 * Manifest validator for this single-plugin repository.
 *
 * The cursor-plugins script `scripts/validate-plugins.mjs` cannot validate this
 * repository. It hard-codes the cursor-plugins checkout as its root, requires
 * that checkout's `.cursor-plugin/marketplace.json`, and imports `ajv`. This
 * script is the local equivalent: it checks `.cursor-plugin/plugin.json`
 * against the plugin schema's required name, kebab-case pattern, author shape,
 * closed property set, and relative component paths, then checks skill
 * frontmatter.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedKeys = new Set([
  "name",
  "displayName",
  "description",
  "version",
  "minClientVersions",
  "author",
  "publisher",
  "homepage",
  "repository",
  "license",
  "logo",
  "keywords",
  "category",
  "tags",
  "commands",
  "agents",
  "skills",
  "rules",
  "hooks",
  "variables",
  "mcpServers",
]);
const namePattern = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let errors = 0;

function fail(message) {
  console.error(`ERROR: ${message}`);
  errors += 1;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function assertRelative(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty relative path`);
    return;
  }
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) {
    fail(`${label} must be a relative path, got "${value}"`);
  }
  const parts = value.split(/[\\/]+/);
  if (parts.includes("..")) {
    fail(`${label} must not contain parent traversal, got "${value}"`);
  }
}

function parseFrontmatter(text, label) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    fail(`${label}: missing frontmatter`);
    return null;
  }
  const lines = match[1].split(/\r?\n/);
  let name = "";
  let description = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("name:")) {
      name = unquote(line.slice("name:".length).trim());
    } else if (line.startsWith("description:")) {
      const rest = line.slice("description:".length).trim();
      if (rest === ">-" || rest === ">" || rest === "|") {
        const chunks = [];
        i += 1;
        while (i < lines.length && /^( {2}|\t)/.test(lines[i])) {
          chunks.push(lines[i].trim());
          i += 1;
        }
        i -= 1;
        description = chunks.join(" ").trim();
      } else {
        description = unquote(rest);
      }
    }
  }
  const body = text.slice(match[0].length).trim();
  return { name, description, body };
}

function checkSkillFile(skillPath, expectedName) {
  if (!existsSync(skillPath)) {
    fail(`missing skill file ${skillPath}`);
    return;
  }
  const parsed = parseFrontmatter(readFileSync(skillPath, "utf8"), skillPath);
  if (!parsed) {
    return;
  }
  if (!parsed.name) {
    fail(`${skillPath}: frontmatter name is required`);
  } else if (!namePattern.test(parsed.name)) {
    fail(`${skillPath}: name "${parsed.name}" is not kebab-case`);
  } else if (expectedName && parsed.name !== expectedName) {
    fail(`${skillPath}: name "${parsed.name}" does not match directory "${expectedName}"`);
  }
  if (!parsed.description) {
    fail(`${skillPath}: frontmatter description is required`);
  }
  if (!parsed.body) {
    fail(`${skillPath}: skill body is empty`);
  }
}

function checkDefaultSkills() {
  const skillsDir = join(root, "skills");
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
    fail("skills/ directory is required for default skill discovery");
    return;
  }
  const entries = readdirSync(skillsDir);
  if (entries.length === 0) {
    fail("skills/ contains no skills");
  }
  for (const entry of entries) {
    const skillDir = join(skillsDir, entry);
    if (!statSync(skillDir).isDirectory()) {
      fail(`skills/${entry} is not a skill directory`);
      continue;
    }
    checkSkillFile(join(skillDir, "SKILL.md"), entry);
  }
}

const pluginPath = join(root, ".cursor-plugin", "plugin.json");
if (!existsSync(pluginPath)) {
  fail(".cursor-plugin/plugin.json not found");
} else {
  let plugin;
  try {
    plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
  } catch (error) {
    fail(`plugin.json is not valid JSON: ${error.message}`);
    plugin = null;
  }
  if (plugin && (typeof plugin !== "object" || Array.isArray(plugin))) {
    fail("plugin.json must be an object");
    plugin = null;
  }
  if (plugin) {
    for (const key of Object.keys(plugin)) {
      if (!allowedKeys.has(key)) {
        fail(`plugin.json has unsupported property "${key}"`);
      }
    }
    if (typeof plugin.name !== "string" || !namePattern.test(plugin.name)) {
      fail('plugin.json name must be kebab-case matching "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$"');
    }
    if (typeof plugin.description !== "string" || plugin.description.trim() === "") {
      fail("plugin.json description must be a non-empty string");
    }
    if (typeof plugin.version !== "string" || !semverPattern.test(plugin.version)) {
      fail('plugin.json version must be a semantic version such as "1.0.0"');
    }
    if (typeof plugin.license !== "string" || plugin.license.trim() === "") {
      fail("plugin.json license must be a non-empty string");
    }
    if (!plugin.author || typeof plugin.author !== "object" || Array.isArray(plugin.author)) {
      fail("plugin.json author must be an object with a name");
    } else {
      if (typeof plugin.author.name !== "string" || plugin.author.name.trim() === "") {
        fail("plugin.json author.name is required");
      }
      const authorKeys = Object.keys(plugin.author);
      for (const key of authorKeys) {
        if (key !== "name" && key !== "email") {
          fail(`plugin.json author has unsupported property "${key}"`);
        }
      }
      if (plugin.author.email !== undefined && !emailPattern.test(plugin.author.email)) {
        fail("plugin.json author.email is not a valid email address");
      }
    }
    if (plugin.keywords !== undefined) {
      if (!Array.isArray(plugin.keywords) || plugin.keywords.some((item) => typeof item !== "string")) {
        fail("plugin.json keywords must be an array of strings");
      }
    }
    for (const key of ["commands", "agents", "skills", "rules", "logo"]) {
      const value = plugin[key];
      if (typeof value === "string") {
        assertRelative(value, `plugin.json ${key}`);
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => assertRelative(item, `plugin.json ${key}[${index}]`));
      }
    }
    if (plugin.skills === undefined) {
      checkDefaultSkills();
    } else if (typeof plugin.skills === "string") {
      checkSkillFile(join(root, plugin.skills), "");
    } else if (Array.isArray(plugin.skills)) {
      for (const item of plugin.skills) {
        if (typeof item === "string") {
          checkSkillFile(join(root, item), "");
        }
      }
    }
  }
}

for (const filename of ["README.md", "LICENSE", "CHANGELOG.md"]) {
  if (!existsSync(join(root, filename))) {
    fail(`missing ${filename}`);
  }
}

const licensePath = join(root, "LICENSE");
if (existsSync(licensePath)) {
  const license = readFileSync(licensePath, "utf8");
  if (!license.includes("MIT License")) {
    fail("LICENSE is not the MIT license text");
  }
  if (!license.includes("ArchAgents")) {
    fail("LICENSE must name author ArchAgents");
  }
}

const readmePath = join(root, "README.md");
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, "utf8");
  if (!/install/i.test(readme)) {
    fail("README.md must describe installation");
  }
  if (!readme.includes("skills/setup-mentions/SKILL.md") || !readme.includes("skills/handle-mention/SKILL.md")) {
    fail("README.md must cover the setup-mentions and handle-mention skills");
  }
}

if (errors > 0) {
  console.error(`\nValidation failed with ${errors} error(s).`);
  console.error(
    "Note: cursor-plugins scripts/validate-plugins.mjs hard-codes that checkout, requires its marketplace.json, and imports ajv. It cannot validate this single-plugin repo. Use scripts/validate-plugin.mjs."
  );
  process.exit(1);
}

console.log("Validated .cursor-plugin/plugin.json and skill frontmatter.");
console.log(
  "Note: cursor-plugins scripts/validate-plugins.mjs hard-codes that checkout, requires its marketplace.json, and imports ajv. It cannot validate this single-plugin repo. Use scripts/validate-plugin.mjs."
);
process.exit(0);
