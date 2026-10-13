#!/usr/bin/env node
// Goals gate for the mentions plugin. Checks a checkout against the product
// goals (a-d) before any feature drive. Read-only on the checkout: every command
// runs in a scratch copy with a sandbox HOME, no GitHub token, git limited to
// file:// transports, and no network when `unshare -rn` is available.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, "..");

const GOALS = {
  a: "clear installation instructions",
  b: "a public repository that reads as finished product work",
  c: "works for any user and any bot handle, with the script packaged and explained for people and agents",
  d: "a Grok Bot-native Cursor plugin ready for marketplace submission",
};

const HELP = `usage: goals-gate.mjs [--repo PATH] [--out DIR] [options]

Checks a mentions checkout against the v1.1 goals and prints one line per gate:
PASS, FAIL, WARN (reported, not failing), JUDGE (evidence for a reader to judge),
or BLOCKED (could not evaluate, for example a missing tool).

Options:
  --repo PATH            checkout to check (default: git toplevel of cwd)
  --out DIR              write goals-gate.txt, goals-gate.json, and transcripts here
                         (default: a new directory under \${TMPDIR:-/tmp})
  --expect-version X     require plugin.json and CHANGELOG to be version X
  --handles REGEX        personal handles to hunt (case-insensitive). Required.
                         No built-in list. If omitted, the first non-comment line of
                         handles.local next to this skill is used.
  --slug OWNER/REPO      GitHub slug whose clone URLs map to the local checkout
                         (default: from origin, then plugin.json repository)
  --plugin-dir DIR       where an installed plugin must appear, relative to the
                         sandbox HOME; repeatable (default: .cursor/plugins/local)
  --only IDS             comma-separated gate ids or goal letters (e.g. a,c1-no-personal-handles)
  --online               also check external links with HEAD/GET (no auth, no writes)
  --list                 list gates and exit
  -h, --help             show this help

Exit: 0 no FAIL or BLOCKED, 1 any FAIL, 2 usage error, 3 BLOCKED without FAIL.

Example:
  .cursor/skills/verify-mentions/scripts/goals-gate.mjs --repo . --out /tmp/gate --expect-version 1.1.0`;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { pluginDirs: [], only: null, online: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) usage(`${arg} requires a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--repo": opts.repo = value(); break;
      case "--out": opts.out = value(); break;
      case "--expect-version": opts.expectVersion = value(); break;
      case "--handles": opts.handles = value(); break;
      case "--slug": opts.slug = value(); break;
      case "--plugin-dir": opts.pluginDirs.push(value()); break;
      case "--only": opts.only = value().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--online": opts.online = true; break;
      case "--list": opts.list = true; break;
      case "-h":
      case "--help": console.log(HELP); process.exit(0);
      default: usage(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function usage(message) {
  console.error(`error: ${message}\n\n${HELP}`);
  process.exit(2);
}

// ---------------------------------------------------------------- process helpers

const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
// Host settings that would override the sandbox identity or point git/gh elsewhere.
const LEAK_VARS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE", "EMAIL",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES",
  "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_PROXY_COMMAND", "GH_HOST", "GH_REPO", "GH_ENTERPRISE_HOST", "GITHUB_API_URL"];

function run(cmd, args, { cwd, env, timeout = 120000, input } = {}) {
  const res = spawnSync(cmd, args, { cwd, env, timeout, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    code: res.error ? (res.error.code === "ENOENT" ? 127 : 125) : res.status ?? 128 + (res.signal ? 15 : 0),
    stdout: res.stdout ?? "",
    stderr: (res.stderr ?? "") + (res.error ? `\n${res.error.message}` : ""),
    timedOut: res.error?.code === "ETIMEDOUT",
  };
}

function git(repo, args) {
  return run("git", ["-C", repo, ...args]);
}

let offlineAvailable = null;
function canGoOffline() {
  if (offlineAvailable === null) offlineAvailable = run("unshare", ["-rn", "true"]).code === 0;
  return offlineAvailable;
}

function offline(cmd, args) {
  return canGoOffline() ? ["unshare", ["-rn", "--", cmd, ...args]] : [cmd, args];
}

function hostEnvWithoutLeaks() {
  const env = { ...process.env };
  for (const name of [...TOKEN_VARS, ...LEAK_VARS]) delete env[name];
  return env;
}

function sandboxEnv(box, extra = {}) {
  return {
    ...hostEnvWithoutLeaks(),
    HOME: box.home,
    TMPDIR: box.tmp,
    GIT_CONFIG_GLOBAL: join(box.home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GH_CONFIG_DIR: join(box.home, ".config", "gh"),
    GH_PROMPT_DISABLED: "1",
    PATH: `${box.bin}:${process.env.PATH}`,
    ...extra,
  };
}

function shQuote(s) {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- sandbox

function copyTree(ctx, dest) {
  const list = git(ctx.repo, ["ls-files", "-co", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean);
  for (const rel of list) {
    const src = join(ctx.repo, rel);
    let st;
    try { st = lstatSync(src); } catch { continue; }
    const out = join(dest, rel);
    mkdirSync(dirname(out), { recursive: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), out);
    else if (st.isFile()) { copyFileSync(src, out); chmodSync(out, st.mode & 0o777); }
  }
  const id = ["-c", "user.name=goals-gate", "-c", "user.email=goals-gate@example.invalid"];
  const env = hostEnvWithoutLeaks();
  run("git", ["init", "-q", "-b", "main", dest], { env });
  run("git", ["-C", dest, "add", "-A"], { env });
  run("git", ["-C", dest, ...id, "commit", "-q", "--no-verify", "-m", "goals-gate snapshot"], { env });
}

function makeBox(ctx, label) {
  const root = join(ctx.scratch, label);
  const box = { root, home: join(root, "home"), tmp: join(root, "tmp"), bin: join(root, "bin"), src: join(root, "src", ctx.pluginName) };
  for (const d of [box.home, box.tmp, box.bin, dirname(box.src)]) mkdirSync(d, { recursive: true });
  copyTree(ctx, box.src);
  const urls = ctx.slug
    ? [`https://github.com/${ctx.slug}.git`, `https://github.com/${ctx.slug}`, `git@github.com:${ctx.slug}.git`, `ssh://git@github.com/${ctx.slug}.git`]
    : [];
  const insteadOf = urls.map((u) => `\tinsteadOf = ${u}`).join("\n");
  writeFileSync(
    join(box.home, ".gitconfig"),
    `[user]\n\tname = Sandbox User\n\temail = sandbox@example.invalid\n[safe]\n\tdirectory = *\n${urls.length ? `[url "${ctx.repo}"]\n${insteadOf}\n` : ""}`,
  );
  const ghLog = join(box.root, "gh-calls.txt");
  writeFileSync(join(box.bin, "gh"), `#!/usr/bin/env bash\nprintf 'gh %s\\n' "$*" >> '${ghLog}'\necho "goals-gate: gh is not allowed in this sandbox" >&2\nexit 97\n`);
  chmodSync(join(box.bin, "gh"), 0o755);
  box.ghLog = ghLog;
  return box;
}

function ghCalls(box) {
  return existsSync(box.ghLog) ? readFileSync(box.ghLog, "utf8").trim().split("\n").filter(Boolean) : [];
}

// ---------------------------------------------------------------- markdown

function parseMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const headings = [];
  const blocks = [];
  const prose = [];
  let fence = null;
  lines.forEach((line, i) => {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === "") {
        blocks.push({ info: fence.info, start: fence.start, end: i, body: fence.body.join("\n") });
        fence = null;
      } else fence.body.push(line);
      return;
    }
    if (m) {
      fence = { ch: m[1][0], len: m[1].length, info: m[2].trim().split(/\s+/)[0].toLowerCase(), start: i, body: [] };
      return;
    }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) headings.push({ level: h[1].length, title: h[2], line: i });
    prose.push({ i, line });
  });
  return { lines, headings, blocks, prose };
}

function sectionOf(md, heading) {
  const after = md.headings.filter((h) => h.line > heading.line && h.level <= heading.level);
  const end = after.length ? after[0].line : md.lines.length;
  return { heading, start: heading.line, end };
}

function within(sec, item) {
  const line = item.start ?? item.line ?? item.i;
  return line > sec.start && line < sec.end;
}

const SHELL_INFOS = new Set(["bash", "sh", "shell", "zsh", "console"]);

function shellText(block) {
  if (block.info !== "console") return block.body;
  return block.body.split("\n").filter((l) => /^\s*\$ /.test(l)).map((l) => l.replace(/^\s*\$ /, "")).join("\n");
}

function slugify(title) {
  return title.toLowerCase().replace(/[`*_~]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s/g, "-");
}

// ---------------------------------------------------------------- results

function result(status, summary, evidence = [], fix) {
  return { status, summary, evidence, fix };
}
const PASS = (s, e, f) => result("PASS", s, e, f);
const FAIL = (s, e, f) => result("FAIL", s, e, f);
const WARN = (s, e, f) => result("WARN", s, e, f);
const JUDGE = (s, e, f) => result("JUDGE", s, e, f);
const BLOCKED = (s, e, f) => result("BLOCKED", s, e, f);

function saveTranscript(ctx, name, parts) {
  const file = join(ctx.out, "transcripts", name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, parts.join("\n"));
  return relative(ctx.out, file);
}

// ---------------------------------------------------------------- shared facts

const CODE_ROOTS = ["scripts/", "skills/", "templates/", "rules/", "agents/", "commands/", "hooks/", ".github/", ".cursor-plugin/", "mcp.json"];
const VERIFY_SKILL = ".cursor/skills/verify-mentions/";
const ROOT_ALLOW = new Set([
  "README.md", "LICENSE", "LICENSE.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "AGENTS.md",
  ".gitignore", ".gitattributes", ".editorconfig", "mcp.json",
]);
const DIR_ALLOW = [".cursor-plugin/", ".github/", "skills/", "scripts/", "templates/", "assets/", "rules/", "agents/", "commands/", "hooks/", "docs/", "examples/", "tests/", "test/", VERIFY_SKILL];
const STRAY = /(^|\/)(DONE\.txt|REVIEW\.md|RELEASE\.md|NOTES\.md|TODO\.md|PROMPT\.md|scratch[^/]*|[^/]*\.(bak|orig|rej|tmp|log)|\.DS_Store)$|(^|\/)\.src\//i;
// Paths the docs name in another repository: the user's target repo (the rendered
// workflow) or the cursor/plugins marketplace checkout. Not expected to exist here.
const NOT_THIS_REPO = new Set([".github/workflows/mention-forward.yml", ".cursor-plugin/marketplace.json"]);

function tracked(ctx) {
  return git(ctx.repo, ["ls-files", "-z"]).stdout.split("\0").filter(Boolean);
}

function shipped(ctx) {
  return ctx.tracked.filter((f) => !f.startsWith(VERIFY_SKILL));
}

function read(ctx, rel) {
  const p = join(ctx.repo, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function isTestFile(rel) {
  return /(^|\/)tests?\//.test(rel) || /\.test\.[a-z]+$/.test(rel) || /(^|\/)test[^/]*\.sh$/.test(rel);
}

// ---------------------------------------------------------------- JSON schema (draft-07 subset)

function validateSchema(rootSchema, value) {
  const errors = [];
  const handled = new Set(["$schema", "$id", "title", "description", "$defs", "definitions", "type", "required", "additionalProperties",
    "properties", "pattern", "minLength", "minProperties", "items", "uniqueItems", "const", "oneOf", "anyOf", "enum", "$ref", "format"]);
  const deref = (ref) => ref.replace(/^#\//, "").split("/").reduce((node, key) => node?.[key], rootSchema);
  const typeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : Number.isInteger(v) ? "integer" : typeof v);
  function check(schema, v, path) {
    if (schema.$ref) return check(deref(schema.$ref), v, path);
    for (const key of Object.keys(schema)) if (!handled.has(key)) errors.push(`${path || "/"}: unsupported schema keyword "${key}" (gate cannot vouch for it)`);
    const before = errors.length;
    if (schema.type) {
      const t = typeOf(v);
      const ok = [].concat(schema.type).some((want) => want === t || (want === "number" && t === "integer"));
      if (!ok) { errors.push(`${path || "/"}: must be ${schema.type}, got ${t}`); return; }
    }
    if (schema.const !== undefined && v !== schema.const) errors.push(`${path || "/"}: must equal ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.includes(v)) errors.push(`${path || "/"}: must be one of ${JSON.stringify(schema.enum)}`);
    if (typeof v === "string") {
      if (schema.minLength !== undefined && v.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
      if (schema.pattern && !new RegExp(schema.pattern, "u").test(v)) errors.push(`${path}: does not match ${schema.pattern}`);
      if (schema.format === "uri") { try { new URL(v); if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) throw 0; } catch { errors.push(`${path}: not an absolute URI`); } }
      if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errors.push(`${path}: not an email address`);
    }
    if (Array.isArray(v)) {
      if (schema.items) v.forEach((item, i) => check(schema.items, item, `${path}/${i}`));
      if (schema.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errors.push(`${path}: items must be unique`);
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const req of schema.required ?? []) if (!(req in v)) errors.push(`${path || "/"}: missing required property "${req}"`);
      if (schema.minProperties !== undefined && Object.keys(v).length < schema.minProperties) errors.push(`${path || "/"}: needs at least ${schema.minProperties} properties`);
      for (const [key, sub] of Object.entries(v)) {
        if (schema.properties?.[key]) check(schema.properties[key], sub, `${path}/${key}`);
        else if (schema.additionalProperties === false) errors.push(`${path || "/"}: unsupported property "${key}"`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === "object") check(schema.additionalProperties, sub, `${path}/${key}`);
      }
    }
    for (const [kw, need] of [["oneOf", 1], ["anyOf", 0]]) {
      if (!schema[kw]) continue;
      let passing = 0;
      for (const option of schema[kw]) {
        const saved = errors.length;
        check(option, v, path);
        if (errors.length === saved) passing += 1;
        errors.length = saved;
      }
      if (kw === "oneOf" ? passing !== need : passing === 0) errors.push(`${path || "/"}: must match ${kw === "oneOf" ? "exactly one" : "at least one"} schema in ${kw} (matched ${passing})`);
    }
    return errors.length === before;
  }
  check(rootSchema, value, "");
  return errors;
}

function schemaSource(ctx, file) {
  const live = process.env.CURSOR_PLUGINS_DIR && join(process.env.CURSOR_PLUGINS_DIR, "schemas", file);
  const path = live && existsSync(live) ? live : join(SKILL_DIR, "schemas", file);
  return { path, schema: JSON.parse(readFileSync(path, "utf8")) };
}

function marketplaceNames() {
  const liveDir = process.env.CURSOR_PLUGINS_DIR;
  const live = liveDir && join(liveDir, ".cursor-plugin", "marketplace.json");
  if (live && existsSync(live)) return { source: live, names: JSON.parse(readFileSync(live, "utf8")).plugins.map((p) => p.name) };
  const file = join(SKILL_DIR, "schemas", "marketplace-names.txt");
  return { source: file, names: readFileSync(file, "utf8").split("\n").filter(Boolean) };
}

// ---------------------------------------------------------------- gates: goal a

function installSection(ctx) {
  const h = ctx.readmeMd.headings.find((x) => x.level === 2 && /install|getting started|quick ?start/i.test(x.title));
  return h ? sectionOf(ctx.readmeMd, h) : null;
}

function gateA1(ctx) {
  const sec = installSection(ctx);
  if (!sec) return FAIL("README.md has no H2 install / getting-started section", [`H2s: ${ctx.readmeMd.headings.filter((h) => h.level === 2).map((h) => h.title).join(" | ")}`], "Add `## Install` near the top with a fenced bash block a user can paste.");
  const blocks = ctx.readmeMd.blocks.filter((b) => within(sec, b) && SHELL_INFOS.has(b.info));
  const h2s = ctx.readmeMd.headings.filter((h) => h.level === 2);
  const position = h2s.indexOf(sec.heading) + 1;
  const ev = [`"## ${sec.heading.title}" at README.md:${sec.heading.line + 1}, H2 #${position} of ${h2s.length}`, ...blocks.map((b) => `block README.md:${b.start + 1}: ${b.body.split("\n").join(" ⏎ ")}`)];
  if (!blocks.length) return FAIL("install section has no fenced shell block to paste", ev, "Put the exact commands in a ```bash block.");
  return PASS(`"${sec.heading.title}" has ${blocks.length} fenced shell block(s)`, ev);
}

function discovered(ctx, box) {
  const dirs = ctx.pluginDirs.length ? ctx.pluginDirs : [".cursor/plugins/local"];
  const found = [];
  for (const d of dirs) {
    const abs = join(box.home, d);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs)) {
      let real;
      try { real = realpathSync(join(abs, entry)); } catch { continue; }
      const manifest = join(real, ".cursor-plugin", "plugin.json");
      if (!existsSync(manifest)) continue;
      let name = null;
      try { name = JSON.parse(readFileSync(manifest, "utf8")).name; } catch { /* reported below */ }
      const skills = existsSync(join(real, "skills")) ? readdirSync(join(real, "skills")).filter((s) => existsSync(join(real, "skills", s, "SKILL.md"))) : [];
      found.push({ at: `~/${d}/${entry}`, name, skills });
    }
  }
  return found.filter((f) => f.name === ctx.pluginName && f.skills.length);
}

function gateA2(ctx) {
  const sec = installSection(ctx);
  if (!sec) return FAIL("no install section to run (see a1)");
  const md = ctx.readmeMd;
  const subs = md.headings.filter((h) => within(sec, h) && h.level === sec.heading.level + 1).map((h) => sectionOf(md, h));
  const shellIn = (range, exclude = []) => md.blocks.filter((b) => within(range, b) && SHELL_INFOS.has(b.info) && !exclude.some((x) => within(x, b)));
  const prefix = shellIn(sec, subs);
  const paths = subs.length
    ? subs.map((s) => ({ name: s.heading.title, blocks: [...prefix, ...shellIn(s)] })).filter((p) => p.blocks.length > prefix.length || !prefix.length)
    : [{ name: sec.heading.title, blocks: prefix }];
  const runnable = paths.filter((p) => p.blocks.length);
  if (!runnable.length) return FAIL("install section has no shell block to execute (see a1)");
  const ev = [];
  let failures = 0;
  runnable.forEach((p, n) => {
    const script = p.blocks.map(shellText).join("\n");
    const placeholders = script.match(/<[A-Za-z][^>\n]*>/g);
    if (placeholders) {
      failures += 1;
      ev.push(`path "${p.name}": not runnable as pasted, placeholders ${[...new Set(placeholders)].join(" ")}`);
      return;
    }
    const box = makeBox(ctx, `a2-path${n + 1}`);
    const [cmd, args] = offline("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script]);
    const res = run(cmd, args, { cwd: box.src, env: sandboxEnv(box), timeout: 60000 });
    const found = discovered(ctx, box);
    const t = saveTranscript(ctx, `a2-install-path${n + 1}.txt`, [
      `path: ${p.name}`, `network: ${canGoOffline() ? "none (unshare -rn)" : "host (unshare unavailable; git limited to file://, gh stubbed)"}`,
      `cwd: <sandbox>/src/${ctx.pluginName} (copy of the checkout's tracked and unignored files)`, "HOME: <sandbox>/home (empty)",
      "--- script", script, `--- exit ${res.code}${res.timedOut ? " (timeout 60s)" : ""}`, "--- stdout", res.stdout, "--- stderr", res.stderr,
      `--- gh calls: ${ghCalls(box).join("; ") || "none"}`, `--- plugins discovered: ${JSON.stringify(found)}`,
    ]);
    const firstErr = res.stderr.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
    if (res.code !== 0) { failures += 1; ev.push(`path "${p.name}": exit ${res.code} in a clean HOME: ${firstErr} (${t})`); }
    else if (!found.length) { failures += 1; ev.push(`path "${p.name}": exit 0 but no "${ctx.pluginName}" plugin with skills under ~/${(ctx.pluginDirs[0] ?? ".cursor/plugins/local")} (${t})`); }
    else ev.push(`path "${p.name}": exit 0, discovered ${found.map((f) => `${f.at} [skills: ${f.skills.join(", ")}]`).join("; ")} (${t})`);
  });
  if (failures) return FAIL(`${failures} of ${runnable.length} install path(s) fail when pasted into a clean machine`, ev, "Make every install block run as-is from a fresh shell: create parent dirs (mkdir -p), clone if needed, no <placeholders>.");
  return PASS(`${runnable.length} install path(s) run as pasted and leave a discoverable plugin`, ev);
}

function gateA3(ctx) {
  const sec = installSection(ctx);
  if (!sec) return FAIL("no install section (see a1)");
  const text = ctx.readmeMd.lines.slice(sec.start, sec.end).join("\n");
  const clone = text.match(/git clone\s+(\S+)/);
  const market = /marketplace|cursor\.com\/(marketplace|plugins)|\/plugins? install|install from the/i.test(text);
  const ev = [clone ? `git clone source: ${clone[1]}` : "no git clone in the install section", market ? "marketplace install mentioned" : "no marketplace install path"];
  if (!clone && !market) return FAIL("install section assumes the reader already has the code", ev, "Start with how to get it: the marketplace listing and/or `git clone https://github.com/<owner>/mentions ~/.cursor/plugins/local/mentions`.");
  return PASS("install section says how to get the code", ev);
}

function gateA4(ctx) {
  const h = ctx.readmeMd.headings.find((x) => /requirement|prerequisite|before you (begin|start)|dependencies/i.test(x.title));
  const tools = ["git", "gh", "node", "jq", "curl", "shellcheck", "actionlint", "herdr"];
  const used = tools.filter((t) => ctx.shippedText.code.some((c) => new RegExp(`(^|[\\s\`"'(|;&])${t}(\\s|$|\`)`, "m").test(c)));
  const mentioned = used.filter((t) => new RegExp(`\\b${t}\\b`).test(ctx.readme));
  const ev = [`tools used by shipped code/docs: ${used.join(", ")}`, `named in README: ${mentioned.join(", ") || "none"}`];
  if (!h) return FAIL("README has no requirements / prerequisites section", ev, "Add `## Requirements` listing each tool, the minimum version, and why (git + gh to install, herdr + a Grok Bot routine to handle, node/shellcheck/actionlint to develop).");
  return PASS(`"${h.title}" at README.md:${h.line + 1}`, ev);
}

function gateA5(ctx) {
  const box = makeBox(ctx, "a5-help");
  const script = join(box.src, "scripts", "install.sh");
  if (!existsSync(script)) return BLOCKED("scripts/install.sh not found; update the gate if the installer moved");
  const [cmd, args] = offline("bash", [script, "--help"]);
  const res = run(cmd, args, { cwd: box.src, env: sandboxEnv(box) });
  const t = saveTranscript(ctx, "a5-install-help.txt", [`$ scripts/install.sh --help`, `exit ${res.code}`, res.stdout, res.stderr]);
  if (res.code !== 0) return FAIL(`install.sh --help exits ${res.code}`, [t]);
  const helpFlags = new Set(res.stdout.match(/--[a-z][a-z-]*/g) ?? []);
  const docs = [["README.md", ctx.readme], ...ctx.skills.map((s) => [s.rel, s.text])];
  const documented = new Map();
  for (const [rel, text] of docs) {
    text.split("\n").forEach((line, i) => {
      if (!/install\.sh/.test(line) && !/^\s*-\s*`--/.test(line)) return;
      for (const f of line.match(/--[a-z][a-z-]*/g) ?? []) if (!documented.has(f)) documented.set(f, `${rel}:${i + 1}`);
    });
  }
  const missing = [...documented].filter(([f]) => !helpFlags.has(f));
  const undocumented = [...helpFlags].filter((f) => !documented.has(f) && f !== "--help");
  const ev = [`--help exit 0 (${t})`, `help flags: ${[...helpFlags].join(" ")}`, `documented flags: ${[...documented.keys()].join(" ")}`];
  if (missing.length) return FAIL("docs name flags install.sh does not accept", [...ev, ...missing.map(([f, at]) => `${f} at ${at}`)]);
  if (undocumented.length) return WARN(`install.sh flags missing from README/skills: ${undocumented.join(" ")}`, ev);
  return PASS("every documented install.sh flag exists and --help exits 0", ev);
}

// ---------------------------------------------------------------- gates: goal b

function gateB1(ctx) {
  const bad = [];
  for (const f of shipped(ctx)) {
    if (STRAY.test(f)) { bad.push(`${f} (scratch/process artifact)`); continue; }
    if (f.includes("/")) { if (!DIR_ALLOW.some((d) => f.startsWith(d))) bad.push(`${f} (outside the plugin layout)`); }
    else if (!ROOT_ALLOW.has(f)) bad.push(`${f} (unexpected root file)`);
  }
  const ev = [...bad];
  const gi = read(ctx, ".gitignore") ?? "";
  const leaks = gi.split("\n").filter((l) => /^\/?\.src\/?$|scratch|private|notes/i.test(l.trim()));
  if (leaks.length) ev.push(`.gitignore advertises private scratch: ${leaks.join(", ")}`);
  const untracked = git(ctx.repo, ["ls-files", "-o", "--exclude-standard"]).stdout.split("\n").filter((f) => f && !f.startsWith(VERIFY_SKILL));
  if (untracked.length) ev.push(`untracked, not ignored (would ship on \`git add -A\`): ${untracked.join(", ")}`);
  const ignoredLocal = git(ctx.repo, ["ls-files", "-o", "-i", "--exclude-standard", "--directory"]).stdout.split("\n").filter(Boolean);
  if (ignoredLocal.length) {
    const groups = new Map();
    for (const p of ignoredLocal) { const key = p.split("/").slice(0, p.startsWith(".cursor/skills/") ? 2 : 1).join("/") + "/"; groups.set(key, (groups.get(key) ?? 0) + 1); }
    ev.push(`local-only, ignored (not shipped): ${[...groups].map(([k, n]) => (n > 1 ? `${k}* (${n})` : k)).join(", ")}`);
  }
  if (bad.length) return FAIL(`${bad.length} tracked file(s) a reviewer would read as leftovers`, ev, "git rm the process files (DONE.txt, REVIEW.md, RELEASE.md); keep release notes in CHANGELOG.md and GitHub Releases.");
  if (leaks.length || untracked.length) return WARN("no stray tracked files, but see evidence", ev);
  return PASS("tracked files match the plugin layout", ev);
}

function gateB2(ctx) {
  const modes = new Map(git(ctx.repo, ["ls-files", "-s"]).stdout.split("\n").filter(Boolean).map((l) => { const [meta, path] = l.split("\t"); return [path, meta.split(" ")[0]]; }));
  const bad = [];
  const ok = [];
  for (const f of shipped(ctx)) {
    const p = join(ctx.repo, f);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    const head = readFileSync(p).subarray(0, 2).toString();
    const inScripts = f.startsWith("scripts/");
    if (head === "#!" || inScripts) {
      if (head !== "#!") bad.push(`${f}: in scripts/ but has no shebang`);
      else if (modes.get(f) !== "100755") bad.push(`${f}: has a shebang but git mode is ${modes.get(f)}`);
      else ok.push(f);
    }
  }
  if (bad.length) return FAIL(`${bad.length} script(s) not executable in git`, bad, "git update-index --chmod=+x <file> (and add a shebang).");
  return PASS(`${ok.length} script(s) have a shebang and git mode 100755`, ok);
}

function ciCommands(ctx) {
  const ci = read(ctx, ".github/workflows/ci.yml");
  if (!ci) return null;
  return ci.split("\n").map((l) => l.match(/^\s*(?:-\s+)?run:\s+(?![|>])(.+?)\s*$/)).filter(Boolean).map((m) => m[1].replace(/^["']|["']$/g, ""))
    .filter((c) => !/apt-get|sudo|brew |curl |npm (ci|install)|pip install/.test(c));
}

function gateB3(ctx) {
  const cmds = ciCommands(ctx);
  if (!cmds) return FAIL(".github/workflows/ci.yml not found");
  const box = makeBox(ctx, "b3-ci");
  const ev = [];
  let failed = 0;
  let blocked = 0;
  cmds.forEach((c, i) => {
    const [cmd, args] = offline("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", c]);
    const res = run(cmd, args, { cwd: box.src, env: sandboxEnv(box), timeout: 300000 });
    const t = saveTranscript(ctx, `b3-ci-${i + 1}.txt`, [`$ ${c}`, `exit ${res.code}`, "--- stdout", res.stdout, "--- stderr", res.stderr]);
    if (res.code === 127) { blocked += 1; ev.push(`BLOCKED ${c}: command not found (${t})`); }
    else if (res.code !== 0) { failed += 1; ev.push(`exit ${res.code}: ${c} (${t})`); }
    else ev.push(`exit 0: ${c} (${t})`);
  });
  ev.push(`gh calls during CI: ${ghCalls(box).join("; ") || "none"}`);
  if (failed) return FAIL(`${failed} of ${cmds.length} CI command(s) fail locally`, ev);
  if (blocked) return BLOCKED(`${blocked} CI command(s) need a missing tool`, ev);
  return PASS(`all ${cmds.length} CI commands exit 0 offline with no GitHub token`, ev);
}

function gateB4(ctx) {
  const ci = read(ctx, ".github/workflows/ci.yml");
  if (!ci) return FAIL("no CI workflow");
  const lines = ci.split("\n");
  const onIdx = lines.findIndex((l) => /^["']?on["']?:/.test(l));
  let events = [];
  if (onIdx >= 0) {
    const inline = lines[onIdx].replace(/^["']?on["']?:\s*/, "").trim();
    if (inline) events = inline.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    else for (let i = onIdx + 1; i < lines.length && /^\s+\S|^\s*$/.test(lines[i]); i += 1) { const m = lines[i].match(/^ {2}([a-z_]+):?/); if (m) events.push(m[1]); }
  }
  const badge = /!\[[^\]]*\]\([^)]*actions\/workflows\/[^)]*badge\.svg[^)]*\)/.test(ctx.readme);
  const ev = [`ci.yml triggers: ${events.join(", ") || "none parsed"}`, `README CI badge: ${badge ? "yes" : "no"}`];
  if (!events.includes("push")) return FAIL("CI never runs on the default branch, so the repo page shows no green check", ev, "Add `push: { branches: [main] }` to ci.yml and a status badge to the README.");
  if (!badge) return WARN("CI runs on push but README has no status badge", ev);
  return PASS("CI runs on push and README shows the badge", ev);
}

function gateB5(ctx) {
  const re = /(^|[\s"'`(=:])(\/(?:workspace|root|home\/(?!runner\/)[a-z_][a-z0-9_-]*|Users\/[^/\s]+)\/|[A-Z]:\\Users\\)/;
  const hits = [];
  for (const f of shipped(ctx)) {
    const text = read(ctx, f);
    if (text === null || text.includes("\0")) continue;
    text.split("\n").forEach((line, i) => { if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`); });
  }
  if (hits.length) return FAIL(`${hits.length} machine-local absolute path(s) in tracked files`, hits, "Remove or rewrite as repo-relative paths.");
  return PASS("no machine-local absolute paths in tracked files");
}

function gateB6(ctx) {
  const broken = [];
  const external = new Set();
  let checked = 0;
  const mdFiles = shipped(ctx).filter((f) => f.endsWith(".md"));
  for (const f of mdFiles) {
    const md = parseMarkdown(read(ctx, f));
    const slugs = new Set(md.headings.map((h) => slugify(h.title)));
    for (const { i, line } of md.prose) {
      const noCode = line.replace(/`[^`]*`/g, "");
      for (const m of noCode.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = m[1];
        if (/^(https?:)?\/\//.test(target)) { external.add(target); continue; }
        if (/^mailto:/.test(target)) continue;
        checked += 1;
        const [path, anchor] = target.split("#");
        const abs = path ? resolve(dirname(join(ctx.repo, f)), decodeURIComponent(path)) : join(ctx.repo, f);
        if (path && !existsSync(abs)) broken.push(`${f}:${i + 1}: link ${target} → missing file`);
        else if (anchor && abs.endsWith(".md") && !new Set(parseMarkdown(readFileSync(abs, "utf8")).headings.map((h) => slugify(h.title))).has(anchor.toLowerCase())) broken.push(`${f}:${i + 1}: link ${target} → missing heading`);
        else if (!path && anchor && !slugs.has(anchor.toLowerCase())) broken.push(`${f}:${i + 1}: link #${anchor} → missing heading`);
      }
    }
  }
  const roots = new Set(readdirSync(ctx.repo));
  const pathDocs = ["README.md", "CHANGELOG.md", ...ctx.skills.map((s) => s.rel)].filter((f) => existsSync(join(ctx.repo, f)));
  for (const f of pathDocs) {
    const md = parseMarkdown(read(ctx, f));
    for (const { i, line } of md.prose) {
      for (const m of line.matchAll(/`([^`\s]+)`/g)) {
        const p = m[1].replace(/^\.\//, "");
        if (!/^[\w.-]+(\/[\w.-]+)+\/?$/.test(p) || /[<>*$~]/.test(p) || NOT_THIS_REPO.has(p)) continue;
        if (!roots.has(p.split("/")[0])) continue;
        checked += 1;
        if (!existsSync(join(ctx.repo, p))) broken.push(`${f}:${i + 1}: path \`${p}\` does not exist`);
      }
    }
  }
  const ev = [`${checked} relative link(s)/path reference(s) checked`, `${external.size} external link(s): ${[...external].join(" ") || "none"}`];
  if (ctx.online) {
    for (const url of external) {
      let res = run("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-I", "-L", "--max-time", "10", url]);
      if (!/^[23]/.test(res.stdout)) res = run("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-L", "--max-time", "10", url]);
      if (!/^[23]/.test(res.stdout)) broken.push(`external ${url} → HTTP ${res.stdout || res.code}`);
    }
  } else if (external.size) ev.push("external links not fetched (pass --online)");
  if (broken.length) return FAIL(`${broken.length} broken reference(s)`, [...broken, ...ev]);
  return PASS("relative links and path references resolve", ev);
}

function gateB7(ctx) {
  const re = "gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{32,}|Bearer [A-Za-z0-9._~+/-]{24,}";
  const head = git(ctx.repo, ["grep", "-n", "-I", "-E", re, "--", ".", `:(exclude)${VERIFY_SKILL}`]);
  const revs = git(ctx.repo, ["rev-list", "--all"]).stdout.split("\n").filter(Boolean);
  const hist = revs.length ? git(ctx.repo, ["grep", "-l", "-I", "-E", re, ...revs, "--", ".", `:(exclude)${VERIFY_SKILL}`]) : { stdout: "" };
  const hits = [...head.stdout.split("\n"), ...hist.stdout.split("\n")].filter(Boolean).map((h) => h.replace(/(gh[pousr]_|github_pat_|xox[abprs]-|AKIA|sk-|Bearer )[A-Za-z0-9._~+/-]{4,}/g, "$1****"));
  if (hits.length) return FAIL(`${hits.length} token-shaped string(s) in the tree or history`, hits, "Rotate the credential first, then rewrite history.");
  return PASS(`no token-shaped strings in HEAD or ${revs.length} commit(s) of history`);
}

function gateB8(ctx) {
  const version = ctx.manifest?.version;
  const changelog = read(ctx, "CHANGELOG.md") ?? "";
  const top = changelog.match(/^##\s+\[?v?(\d+\.\d+\.\d+[^\]\s]*)/m)?.[1];
  const ev = [`plugin.json version: ${version}`, `CHANGELOG top entry: ${top ?? "none"}`, `expected: ${ctx.expectVersion ?? "(not set)"}`];
  if (!top) return FAIL("CHANGELOG.md has no version heading", ev);
  if (version !== top) return FAIL("plugin.json and CHANGELOG disagree on the version", ev);
  if (ctx.expectVersion && version !== ctx.expectVersion) return FAIL(`version is ${version}, expected ${ctx.expectVersion}`, ev, `Bump plugin.json and add a ${ctx.expectVersion} CHANGELOG entry.`);
  return PASS(`version ${version} is consistent`, ev);
}

function gateB9(ctx) {
  const license = read(ctx, "LICENSE");
  const spdx = ctx.manifest?.license;
  if (!license) return FAIL("no LICENSE file");
  const holder = license.match(/^Copyright.*$/m)?.[0] ?? "no copyright line";
  if (spdx === "MIT" && !/MIT License/.test(license)) return FAIL("plugin.json says MIT but LICENSE is not the MIT text", [holder]);
  return PASS(`LICENSE matches plugin.json license "${spdx}"`, [holder]);
}

function gateBJudge(ctx) {
  const authors = git(ctx.repo, ["log", "--format=%an <%ae>"]).stdout.split("\n").filter(Boolean);
  const subjects = git(ctx.repo, ["log", "-8", "--format=%h %s"]).stdout.split("\n").filter(Boolean);
  return JUDGE("read the first screen, attribution, and history", [
    `README first lines: ${ctx.readme.split("\n").slice(0, 6).join(" ⏎ ")}`,
    `plugin.json author: ${JSON.stringify(ctx.manifest?.author)}`,
    `LICENSE holder: ${(read(ctx, "LICENSE") ?? "").match(/^Copyright.*$/m)?.[0] ?? "none"}`,
    `commit authors: ${[...new Set(authors)].map((a) => `${a} ×${authors.filter((x) => x === a).length}`).join(", ")}`,
    ...subjects.map((s) => `commit: ${s}`),
    "Ask: does the first screen say what it does and why it is interesting? Is the human owner credited anywhere a reader looks? Do commit subjects follow one convention?",
  ]);
}

// ---------------------------------------------------------------- gates: goal c

function handleRegex(ctx) {
  return new RegExp(ctx.handles, "i");
}

function gateC1(ctx) {
  const re = handleRegex(ctx);
  const fail = [];
  const warn = [];
  const allowed = [];
  const files = shipped(ctx).filter((f) => CODE_ROOTS.some((r) => f === r || f.startsWith(r)) || f === "README.md" || f === "CHANGELOG.md");
  for (const f of files) {
    if (f === ".cursor-plugin/plugin.json" && ctx.manifest) {
      const { author, publisher, repository, homepage, ...rest } = ctx.manifest;
      const restText = JSON.stringify(rest);
      if (re.test(restText)) fail.push(`${f}: handle outside author/publisher/repository/homepage: ${restText.match(re)[0]}`);
      if (re.test(JSON.stringify({ author, publisher, repository, homepage }))) allowed.push(`${f}: identity fields (author/publisher/repository/homepage)`);
      continue;
    }
    const text = read(ctx, f);
    if (text === null || text.includes("\0")) continue;
    const repoUrl = ctx.slug ? new RegExp(`github\\.com[/:]${ctx.slug.replace(/[.]/g, "\\.")}(\\.git)?`, "gi") : null;
    text.split("\n").forEach((line, i) => {
      if (!re.test(line)) return;
      const at = `${f}:${i + 1}: ${line.trim().slice(0, 120)}`;
      if (repoUrl && !re.test(line.replace(repoUrl, ""))) allowed.push(`${at} [this repo's URL]`);
      else if (/\b(e\.g\.|for example|example|such as|sample)\b/i.test(line)) allowed.push(`${at} [labeled example]`);
      else if ((f === "README.md" || f === "CHANGELOG.md") && /copyright|license/i.test(line)) allowed.push(`${at} [license identity]`);
      else if (isTestFile(f)) warn.push(`${at} [test denylist]`);
      else fail.push(at);
    });
  }
  const ev = [...fail, ...warn.map((w) => `WARN ${w}`), ...allowed.map((a) => `ok ${a}`)];
  if (fail.length) return FAIL(`${fail.length} hardcoded personal handle(s) in shipped code paths`, ev, "Parameterize or move into a clearly labeled example; a fork with its own name must pass every check.");
  if (warn.length) return WARN(`handles appear only in test denylists (${warn.length})`, ev);
  return PASS("no personal handles in shipped code paths outside identity metadata and labeled examples", ev);
}

function gateC2(ctx) {
  const box = makeBox(ctx, "c2-handles");
  const script = join(box.src, "scripts", "install.sh");
  if (!existsSync(script)) return BLOCKED("scripts/install.sh not found");
  const argv = [script, "octo-org/sandbox", "--user", "octo-user", "--bot", "helper-bot", "--secret-prefix", "ACME", "--dry-run"];
  const [cmd, args] = offline("bash", argv);
  const res = run(cmd, args, { cwd: box.src, env: sandboxEnv(box) });
  const t = saveTranscript(ctx, "c2-dry-run.txt", [`$ scripts/install.sh ${argv.slice(1).map(shQuote).join(" ")}`, `exit ${res.code}`, "--- stdout", res.stdout, "--- stderr", res.stderr, `--- gh calls: ${ghCalls(box).join("; ") || "none"}`]);
  const out = res.stdout;
  const need = ["github.actor == 'octo-user'", "'@helper-bot'", "secrets.ACME_WEBHOOK_URL", "secrets.ACME_WEBHOOK_KEY", "secrets.ACME_WEBHOOK_HEADER"];
  const missing = need.filter((s) => !out.includes(s));
  const leaked = (out.match(new RegExp(handleRegex(ctx).source, "gi")) ?? []).concat(out.includes("GROKBOT") ? ["GROKBOT"] : []);
  const ev = [`exit ${res.code} (${t})`, `gh calls: ${ghCalls(box).length}`];
  if (res.code !== 0 || missing.length || leaked.length || ghCalls(box).length) {
    return FAIL("dry-run for a stranger's handles is wrong", [...ev, ...missing.map((m) => `missing: ${m}`), ...leaked.map((l) => `leaked: ${l}`)]);
  }
  return PASS("a stranger's user, bot, and secret prefix render with nothing personal left", ev);
}

function handlerConfigKeys(ctx) {
  const skill = ctx.skills.find((s) => s.dir === "handle-mention");
  if (!skill) return null;
  const md = parseMarkdown(skill.text);
  const h = md.headings.find((x) => /configuration/i.test(x.title));
  const block = md.blocks.find((b) => (h ? within(sectionOf(md, h), b) : true) && /^(ya?ml)$/.test(b.info));
  if (!block) return null;
  return { at: `${skill.rel}:${block.start + 1}`, keys: block.body.split("\n").map((l) => l.match(/^([a-z_][a-z0-9_]*):/)?.[1]).filter(Boolean) };
}

function gateC3(ctx) {
  const cfg = handlerConfigKeys(ctx);
  if (!cfg) return BLOCKED("no yaml configuration block in skills/handle-mention/SKILL.md");
  const linked = [...ctx.readme.matchAll(/\]\(([^)#\s]+)\)/g)].map((m) => m[1]).filter((p) => !/^https?:/.test(p) && existsSync(join(ctx.repo, p)) && statSync(join(ctx.repo, p)).isFile());
  const corpus = [ctx.readme, ...linked.map((p) => read(ctx, p))].join("\n");
  const missing = cfg.keys.filter((k) => !new RegExp(`\\b${k}\\b`).test(corpus));
  const ev = [`handler config keys (${cfg.at}): ${cfg.keys.join(", ")}`, `README-linked files searched: ${linked.join(", ") || "none"}`];
  if (missing.length) return FAIL(`README never explains ${missing.length} of ${cfg.keys.length} handler setting(s)`, [...ev, `missing: ${missing.join(", ")}`], "Ship an example config (e.g. examples/handler.yml) with every key commented, link it from the README, and say where the file goes.");
  return PASS("every handler setting is documented from the README", ev);
}

function gateC4(ctx) {
  const h = ctx.readmeMd.headings.find((x) => /how it works|how this works|architecture|overview/i.test(x.title));
  const h2s = ctx.readmeMd.headings.filter((x) => x.level === 2).map((x) => x.title);
  if (!h) return FAIL("README has no how-it-works section", [`H2s: ${h2s.join(" | ")}`], "Add `## How it works`: mention → Actions workflow → webhook routine → handle-mention → ack/progress/reply, with a small diagram.");
  const sec = sectionOf(ctx.readmeMd, h);
  const text = ctx.readmeMd.lines.slice(sec.start, sec.end).join("\n");
  const parts = { workflow: /workflow|github actions/i, webhook: /webhook|routine/i, handler: /handle-mention|handler/i };
  const missing = Object.entries(parts).filter(([, re]) => !re.test(text)).map(([k]) => k);
  if (missing.length) return FAIL(`"${h.title}" skips: ${missing.join(", ")}`, [`README.md:${h.line + 1}`]);
  return PASS(`"${h.title}" walks workflow → webhook → handler`, [`README.md:${h.line + 1}`]);
}

function gateCJudge(ctx) {
  const mentions = (re) => ctx.readme.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l)).map(([n, l]) => `README.md:${n}: ${l.trim().slice(0, 140)}`);
  return JUDGE("could a stranger (human or agent) wire this to their own handle from the README alone?", [
    ...mentions(/herdr/i),
    ...mentions(/routine/i).slice(0, 4),
    "Ask: is herdr explained or linked for outsiders? Does the README say where the handler runs and where its config/state live? Would an agent reading only skills/*/SKILL.md know every value to ask the user for?",
  ]);
}

// ---------------------------------------------------------------- gates: goal d

function gateD1(ctx) {
  if (!ctx.manifest) return FAIL(`.cursor-plugin/plugin.json missing or invalid JSON: ${ctx.manifestError}`);
  const { path, schema } = schemaSource(ctx, "plugin.schema.json");
  const errors = validateSchema(schema, ctx.manifest);
  const ev = [`schema: ${path.startsWith(ctx.repo) ? relative(ctx.repo, path) : path}`];
  if (errors.length) return FAIL(`plugin.json fails the official schema (${errors.length})`, [...ev, ...errors]);
  return PASS("plugin.json validates against the official plugin schema", ev);
}

function gateD2(ctx) {
  const m = ctx.manifest;
  if (!m) return FAIL("no manifest (see d1)");
  const problems = [];
  for (const k of ["displayName", "description", "version", "author", "license", "keywords", "tags", "category", "repository", "homepage", "logo"]) if (m[k] === undefined) problems.push(`missing "${k}"`);
  const cats = ["developer-tools", "integrations", "productivity", "utilities"];
  if (m.category && !cats.includes(m.category)) problems.push(`category "${m.category}" not in use on the marketplace (${cats.join(", ")})`);
  for (const k of ["repository", "homepage"]) if (m[k] && !/^https:\/\//.test(m[k])) problems.push(`${k} must be an https URL`);
  if (m.logo) {
    if (/^https?:/.test(m.logo)) problems.push("logo should be repository-hosted (relative path)");
    else if (!existsSync(join(ctx.repo, m.logo))) problems.push(`logo ${m.logo} does not exist`);
    else if (!/\.(png|svg)$/i.test(m.logo)) problems.push(`logo ${m.logo} is not PNG or SVG`);
  }
  if (typeof m.description === "string" && m.description.length > 300) problems.push(`description is ${m.description.length} chars; listing cards truncate long text`);
  const ev = [`present: ${Object.keys(m).join(", ")}`, "baseline: every plugin in cursor/plugins@118e73b sets displayName, description, version, author, license, keywords, tags, category, repository, homepage; 97/100 set logo"];
  if (problems.length) return FAIL(`listing metadata incomplete (${problems.length})`, [...problems, ...ev], "Add tags, repository, homepage, and assets/logo.png (or .svg) referenced from plugin.json.");
  return PASS("manifest has every field marketplace listings carry", ev);
}

function gateD3(ctx) {
  const m = ctx.manifest ?? {};
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
  const grok = m.minClientVersions?.grokbot;
  const problems = [];
  if (!grok) problems.push('plugin.json has no minClientVersions.grokbot, so the listing does not declare Grok Bot support');
  else if (grok !== "never" && !semver.test(grok)) problems.push(`minClientVersions.grokbot "${grok}" is not semver`);
  else if (grok === "never") problems.push("minClientVersions.grokbot is \"never\": hidden from Grok Bot");
  if (!/grok bot/i.test(ctx.readme)) problems.push("README never mentions Grok Bot (where the webhook routine and handler run)");
  const ev = [`minClientVersions: ${JSON.stringify(m.minClientVersions ?? null)}`, "convention: Grok Bot plugins in cursor/plugins set grokbot (and the deprecated alias sand) to a minimum version such as 0.49.0"];
  if (problems.length) return FAIL("not declared or documented as Grok Bot-native", [...problems, ...ev], 'Add "minClientVersions": {"grokbot": "<min>", "sand": "<min>"} and a README section on creating the Grok Bot webhook routine.');
  return PASS(`declares Grok Bot ${grok}+ and documents it`, ev);
}

function gateD4(ctx) {
  const m = ctx.manifest;
  if (!m) return FAIL("no manifest (see d1)");
  const entry = { name: m.name, source: m.name, description: m.description };
  if (m.minClientVersions) entry.minClientVersions = m.minClientVersions;
  const { schema } = schemaSource(ctx, "marketplace.schema.json");
  const doc = { name: "candidate", owner: { name: "candidate" }, plugins: [entry] };
  const errors = validateSchema(schema, doc);
  const { source, names } = marketplaceNames();
  const ev = [`candidate entry: ${JSON.stringify(entry)}`, `names checked against ${names.length} listed plugins (${source.startsWith(SKILL_DIR) ? "vendored snapshot" : source})`];
  if (names.includes(m.name)) errors.push(`name "${m.name}" is already listed on the marketplace`);
  if (errors.length) return FAIL("marketplace entry would be rejected", [...errors, ...ev]);
  return PASS(`marketplace entry for "${m.name}" validates and the name is free`, ev);
}

function gateD5(ctx) {
  const problems = [];
  if (!ctx.skills.length) problems.push("no skills/*/SKILL.md");
  for (const s of ctx.skills) {
    const fm = s.text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!fm) { problems.push(`${s.rel}: no frontmatter`); continue; }
    const name = fm[1].match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1];
    const descRaw = fm[1].match(/^description:\s*(.*)$/m)?.[1] ?? "";
    let desc = descRaw.replace(/^["']|["']$/g, "");
    if (/^[>|]-?$/.test(descRaw.trim())) desc = fm[1].split(/^description:.*$/m)[1].split(/^\S/m)[0].replace(/\s+/g, " ").trim();
    if (name !== s.dir) problems.push(`${s.rel}: name "${name}" does not match directory "${s.dir}"`);
    if (name && name.length > 64) problems.push(`${s.rel}: name longer than 64 chars`);
    if (!desc) problems.push(`${s.rel}: empty description`);
    else if (desc.length > 1024) problems.push(`${s.rel}: description ${desc.length} chars (> 1024)`);
    if (!s.text.slice(fm[0].length).trim()) problems.push(`${s.rel}: empty body`);
  }
  for (const k of ["skills", "rules", "agents", "commands", "hooks", "logo"]) {
    for (const p of [].concat(ctx.manifest?.[k] ?? [])) if (typeof p === "string" && !/^https?:/.test(p) && !/[*?]/.test(p) && !existsSync(join(ctx.repo, p))) problems.push(`plugin.json ${k} path ${p} does not exist`);
  }
  if (problems.length) return FAIL(`component metadata problems (${problems.length})`, problems);
  return PASS(`${ctx.skills.length} skill(s) discoverable with valid frontmatter`, ctx.skills.map((s) => s.rel));
}

function gateDJudge(ctx) {
  return JUDGE("marketplace reviewer read-through", [
    `description (${ctx.manifest?.description?.length ?? 0} chars): ${ctx.manifest?.description}`,
    `keywords: ${JSON.stringify(ctx.manifest?.keywords)}  tags: ${JSON.stringify(ctx.manifest?.tags)}`,
    "Ask: would a marketplace reviewer understand the plugin from description + README in one minute? Does the setup skill's Grok Bot routine guidance match the current Grok Bot UI? Is the plugin scope one clear job?",
  ]);
}

// ---------------------------------------------------------------- registry

const GATES = [
  ["a", "a1-install-section", "README has an install section with a pasteable block", gateA1],
  ["a", "a2-install-block-runs", "install blocks run as pasted in a clean HOME and leave a discoverable plugin", gateA2],
  ["a", "a3-install-from-zero", "install says how to get the code (clone or marketplace)", gateA3],
  ["a", "a4-requirements", "README lists requirements", gateA4],
  ["a", "a5-documented-flags", "documented install.sh flags exist; --help works", gateA5],
  ["b", "b1-no-stray-files", "no scratch/process files tracked", gateB1],
  ["b", "b2-scripts-executable", "scripts have shebangs and git mode 100755", gateB2],
  ["b", "b3-local-ci-green", "CI commands pass locally, offline, tokenless", gateB3],
  ["b", "b4-ci-on-default-branch", "CI runs on the default branch (visible green check)", gateB4],
  ["b", "b5-no-machine-paths", "no machine-local absolute paths", gateB5],
  ["b", "b6-references-resolve", "links and path references resolve", gateB6],
  ["b", "b7-no-secrets", "no token-shaped strings in tree or history", gateB7],
  ["b", "b8-version-consistency", "plugin.json and CHANGELOG versions agree", gateB8],
  ["b", "b9-license", "LICENSE matches manifest", gateB9],
  ["b", "b-judge", "first-screen read-through", gateBJudge],
  ["c", "c1-no-personal-handles", "no personal handles in shipped code paths", gateC1],
  ["c", "c2-arbitrary-handles", "a stranger's handles render cleanly", gateC2],
  ["c", "c3-handler-config-documented", "README explains every handler setting", gateC3],
  ["c", "c4-how-it-works", "README explains the flow end to end", gateC4],
  ["c", "c-judge", "stranger-setup read-through", gateCJudge],
  ["d", "d1-manifest-schema", "plugin.json passes the official schema", gateD1],
  ["d", "d2-listing-fields", "manifest carries marketplace listing fields", gateD2],
  ["d", "d3-grokbot-native", "declares and documents Grok Bot support", gateD3],
  ["d", "d4-marketplace-entry", "marketplace entry validates; name free", gateD4],
  ["d", "d5-components", "skills discoverable with valid frontmatter", gateD5],
  ["d", "d-judge", "marketplace reviewer read-through", gateDJudge],
];

// ---------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    for (const [goal, id, title] of GATES) console.log(`${goal}  ${id.padEnd(30)} ${title}`);
    return 0;
  }
  if (!opts.handles) {
    const local = join(SKILL_DIR, "handles.local");
    if (existsSync(local)) {
      opts.handles = readFileSync(local, "utf8").split("\n").map((s) => s.trim()).find((s) => s && !s.startsWith("#"));
    }
  }
  if (!opts.handles) usage("--handles is required, or put one regular expression in handles.local");
  try { new RegExp(opts.handles, "i"); } catch (e) { usage(`--handles is not a regular expression: ${e.message}`); }
  const top = run("git", ["-C", resolve(opts.repo ?? "."), "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) usage(`not a git checkout: ${opts.repo ?? process.cwd()}`);
  const repo = top.stdout.trim();
  const out = resolve(opts.out ?? mkdtempSync(join(process.env.TMPDIR || tmpdir(), "goals-gate-")));
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "goals-gate-scratch-"));

  const ctx = { repo, out, scratch, online: opts.online, expectVersion: opts.expectVersion, handles: opts.handles, pluginDirs: opts.pluginDirs };
  ctx.tracked = tracked(ctx);
  try { ctx.manifest = JSON.parse(read(ctx, ".cursor-plugin/plugin.json")); } catch (e) { ctx.manifest = null; ctx.manifestError = e.message; }
  ctx.pluginName = ctx.manifest?.name ?? basename(repo);
  ctx.readme = read(ctx, "README.md") ?? "";
  ctx.readmeMd = parseMarkdown(ctx.readme);
  ctx.skills = existsSync(join(repo, "skills"))
    ? readdirSync(join(repo, "skills")).filter((d) => existsSync(join(repo, "skills", d, "SKILL.md"))).map((d) => ({ dir: d, rel: `skills/${d}/SKILL.md`, text: read(ctx, `skills/${d}/SKILL.md`) }))
    : [];
  ctx.shippedText = { code: shipped(ctx).filter((f) => CODE_ROOTS.some((r) => f.startsWith(r)) || f.endsWith(".md")).map((f) => read(ctx, f) ?? "") };
  const origin = git(repo, ["remote", "get-url", "origin"]).stdout.trim();
  ctx.slug = opts.slug ?? origin.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/)?.[1] ?? ctx.manifest?.repository?.match(/github\.com\/([^/]+\/[^/.]+)/)?.[1] ?? null;

  const head = git(repo, ["rev-parse", "--short", "HEAD"]).stdout.trim();
  const dirty = git(repo, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim() ? "yes" : "no";
  const lines = [];
  const say = (s = "") => { lines.push(s); console.log(s); };
  say(`goals gate: ${repo} @ ${head} (tracked changes: ${dirty}) plugin ${ctx.pluginName} ${ctx.manifest?.version ?? "?"}`);
  say(`isolation: ${canGoOffline() ? "no network (unshare -rn)" : "host network (unshare unavailable); git file:// only, gh stubbed"}; GH tokens stripped; sandbox HOME`);
  say(`evidence: ${out}`);

  const selected = GATES.filter(([goal, id]) => !opts.only || opts.only.includes(goal) || opts.only.includes(id));
  const results = [];
  let lastGoal = null;
  for (const [goal, id, title, fn] of selected) {
    if (goal !== lastGoal) { say(""); say(`GOAL ${goal}: ${GOALS[goal]}`); lastGoal = goal; }
    let r;
    try { r = fn(ctx); } catch (e) { r = BLOCKED(`gate crashed: ${e.message}`, [e.stack]); }
    results.push({ goal, id, title, ...r });
    say(`  ${r.status.padEnd(7)} ${id.padEnd(30)} ${r.summary}`);
    for (const e of r.evidence ?? []) say(`          · ${e}`);
    if (r.fix && r.status === "FAIL") say(`          fix: ${r.fix}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  const exit = count("FAIL") ? 1 : count("BLOCKED") ? 3 : 0;
  say("");
  say(`summary: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("WARN")} WARN, ${count("JUDGE")} JUDGE, ${count("BLOCKED")} BLOCKED → exit ${exit}`);
  writeFileSync(join(out, "goals-gate.txt"), `${lines.join("\n")}\n`);
  writeFileSync(join(out, "goals-gate.json"), `${JSON.stringify({ repo, head, dirty, plugin: ctx.pluginName, version: ctx.manifest?.version, goals: GOALS, isolation: canGoOffline() ? "unshare" : "host", results, exit }, null, 2)}\n`);
  rmSync(scratch, { recursive: true, force: true });
  return exit;
}

process.exit(main());
