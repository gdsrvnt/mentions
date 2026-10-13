#!/usr/bin/env node
// Check plugin.json against the vendored Cursor plugin schema, then skill frontmatter.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const namePattern = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

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
  return { name, description, body: text.slice(match[0].length).trim() };
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
  } else if (parsed.description.length > 1024) {
    fail(`${skillPath}: description is longer than 1024 characters`);
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

function schemaErrors(rootSchema, value) {
  const found = [];
  const handled = new Set([
    "$schema", "$id", "title", "description", "$defs", "definitions", "type", "required",
    "additionalProperties", "properties", "pattern", "minLength", "minProperties", "items",
    "uniqueItems", "const", "oneOf", "anyOf", "enum", "$ref", "format",
  ]);
  const deref = (ref) => ref.replace(/^#\//, "").split("/").reduce((node, key) => node?.[key], rootSchema);
  const typeOf = (item) => (Array.isArray(item) ? "array" : item === null ? "null" : Number.isInteger(item) ? "integer" : typeof item);
  function check(schema, item, path) {
    if (!schema) {
      found.push(`${path || "/"}: unresolved schema`);
      return;
    }
    if (schema.$ref) {
      check(deref(schema.$ref), item, path);
      return;
    }
    for (const key of Object.keys(schema)) {
      if (!handled.has(key)) {
        found.push(`${path || "/"}: unsupported schema keyword "${key}"`);
      }
    }
    if (schema.type) {
      const actual = typeOf(item);
      const ok = [].concat(schema.type).some((want) => want === actual || (want === "number" && actual === "integer"));
      if (!ok) {
        found.push(`${path || "/"}: must be ${schema.type}, got ${actual}`);
        return;
      }
    }
    if (schema.const !== undefined && item !== schema.const) {
      found.push(`${path || "/"}: must equal ${JSON.stringify(schema.const)}`);
    }
    if (schema.enum && !schema.enum.includes(item)) {
      found.push(`${path || "/"}: must be one of ${JSON.stringify(schema.enum)}`);
    }
    if (typeof item === "string") {
      if (schema.minLength !== undefined && item.length < schema.minLength) {
        found.push(`${path}: shorter than ${schema.minLength}`);
      }
      if (schema.pattern && !new RegExp(schema.pattern, "u").test(item)) {
        found.push(`${path}: does not match ${schema.pattern}`);
      }
      if (schema.format === "uri") {
        try {
          const url = new URL(item);
          if (!url.protocol) {
            throw new Error("relative");
          }
        } catch {
          found.push(`${path}: not an absolute URI`);
        }
      }
      if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)) {
        found.push(`${path}: not an email address`);
      }
    }
    if (Array.isArray(item)) {
      if (schema.items) {
        item.forEach((entry, index) => check(schema.items, entry, `${path}/${index}`));
      }
      if (schema.uniqueItems && new Set(item.map((entry) => JSON.stringify(entry))).size !== item.length) {
        found.push(`${path}: items must be unique`);
      }
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      for (const req of schema.required ?? []) {
        if (!(req in item)) {
          found.push(`${path || "/"}: missing required property "${req}"`);
        }
      }
      if (schema.minProperties !== undefined && Object.keys(item).length < schema.minProperties) {
        found.push(`${path || "/"}: needs at least ${schema.minProperties} properties`);
      }
      for (const [key, sub] of Object.entries(item)) {
        if (schema.properties?.[key]) {
          check(schema.properties[key], sub, `${path}/${key}`);
        } else if (schema.additionalProperties === false) {
          found.push(`${path || "/"}: unsupported property "${key}"`);
        } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          check(schema.additionalProperties, sub, `${path}/${key}`);
        }
      }
    }
    for (const [keyword, need] of [["oneOf", 1], ["anyOf", 0]]) {
      if (!schema[keyword]) {
        continue;
      }
      let passing = 0;
      for (const option of schema[keyword]) {
        const saved = found.length;
        check(option, item, path);
        if (found.length === saved) {
          passing += 1;
        }
        found.length = saved;
      }
      if (keyword === "oneOf" ? passing !== need : passing === 0) {
        found.push(`${path || "/"}: must match ${keyword}`);
      }
    }
  }
  check(rootSchema, value, "");
  return found;
}

const schemaPath = join(root, "docs/schemas/plugin.schema.json");
const pluginPath = join(root, ".cursor-plugin/plugin.json");
let plugin = null;
if (!existsSync(schemaPath)) {
  fail(`missing vendored schema ${schemaPath}`);
}
if (!existsSync(pluginPath)) {
  fail(".cursor-plugin/plugin.json not found");
} else {
  try {
    plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
  } catch (error) {
    fail(`plugin.json is not valid JSON: ${error.message}`);
    plugin = null;
  }
  if (plugin && existsSync(schemaPath)) {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    for (const message of schemaErrors(schema, plugin)) {
      fail(`plugin.json ${message}`);
    }
  }
  if (plugin && typeof plugin.logo === "string" && !/^https?:/.test(plugin.logo)) {
    if (!existsSync(join(root, plugin.logo))) {
      fail(`plugin.json logo does not exist: ${plugin.logo}`);
    }
  }
  if (plugin && typeof plugin.description === "string" && plugin.description.length > 300) {
    fail(`plugin.json description is ${plugin.description.length} characters`);
  }
}

checkDefaultSkills();

for (const filename of ["README.md", "LICENSE", "CHANGELOG.md"]) {
  if (!existsSync(join(root, filename))) {
    fail(`missing ${filename}`);
  }
}

const license = existsSync(join(root, "LICENSE")) ? readFileSync(join(root, "LICENSE"), "utf8") : "";
if (license && !license.includes("MIT License")) {
  fail("LICENSE is not the MIT license text");
}

const readme = existsSync(join(root, "README.md")) ? readFileSync(join(root, "README.md"), "utf8") : "";
if (readme && !/install/i.test(readme)) {
  fail("README.md must describe installation");
}
if (readme && (!readme.includes("skills/setup-mentions/SKILL.md") || !readme.includes("skills/handle-mention/SKILL.md"))) {
  fail("README.md must cover the setup-mentions and handle-mention skills");
}

if (plugin && typeof plugin.version === "string") {
  const changelog = existsSync(join(root, "CHANGELOG.md")) ? readFileSync(join(root, "CHANGELOG.md"), "utf8") : "";
  if (!changelog.includes(`## [${plugin.version}]`) && !changelog.includes(`## ${plugin.version}`)) {
    fail(`CHANGELOG.md has no ${plugin.version} heading`);
  }
}

if (errors > 0) {
  console.error(`Validation failed with ${errors} error(s).`);
  process.exit(1);
}

console.log("Validated .cursor-plugin/plugin.json and skill frontmatter.");
