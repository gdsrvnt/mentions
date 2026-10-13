#!/usr/bin/env node
// Claim, commit, or release one mention thread.
// stdin: { op, state_dir, work_root, thread_key, owner, repo, ledger_path, request_text, token, agent_name, reply_target }
// claim holds a lease. commit records the seen ledger after dispatch. release drops the lease so a failed launch can retry.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LEASE_MS = 30_000;

function fail(reason) {
  return { ok: false, reason };
}

function segment(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value);
}

function ledgerOk(ledgerPath) {
  return (
    Array.isArray(ledgerPath) &&
    ledgerPath.length === 3 &&
    ledgerPath.every((part) => typeof part === "string" && /^[a-z0-9_-]+$/.test(part) && !part.includes(".."))
  );
}

function lockDir(stateDir, threadKey) {
  return join(stateDir, "locks", threadKey);
}

function readLease(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "lease.json"), "utf8"));
  } catch {
    return null;
  }
}

function stale(lease) {
  if (!lease || typeof lease.expires !== "number") {
    return true;
  }
  return Date.now() > lease.expires;
}

function takeLock(stateDir, threadKey) {
  const dir = lockDir(stateDir, threadKey);
  mkdirSync(join(stateDir, "locks"), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(dir);
      const token = randomBytes(16).toString("hex");
      const lease = { token, pid: process.pid, expires: Date.now() + LEASE_MS };
      writeFileSync(join(dir, "lease.json"), `${JSON.stringify(lease)}\n`);
      return { ok: true, token, dir };
    } catch (error) {
      if (error.code !== "EEXIST") {
        return fail("lock_failed");
      }
      const lease = readLease(dir);
      if (!lease) {
        const age = Date.now() - statSync(dir).mtimeMs;
        if (age < 1000) {
          return fail("busy");
        }
      } else if (!stale(lease)) {
        return fail("busy");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return fail("busy");
}

function checkToken(stateDir, threadKey, token) {
  const lease = readLease(lockDir(stateDir, threadKey));
  if (!lease || lease.token !== token) {
    return fail("lost_lease");
  }
  return { ok: true, dir: lockDir(stateDir, threadKey) };
}

function dropLock(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function seenDir(stateDir, ledgerPath) {
  return join(stateDir, "seen", ...ledgerPath);
}

function requestPath(stateDir, threadKey, ledgerPath) {
  return join(stateDir, "threads", threadKey, "requests", `${ledgerPath[1]}-${ledgerPath[2]}.md`);
}

function queueRequest(input) {
  if (!ledgerOk(input.ledger_path) || typeof input.request_text !== "string") {
    return null;
  }
  const dir = join(input.state_dir, "threads", input.thread_key, "queue");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${input.ledger_path[1]}-${input.ledger_path[2]}.md`);
  try {
    writeFileSync(path, input.request_text, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  return path;
}

function jobPath(stateDir, threadKey) {
  return join(stateDir, "jobs", `${threadKey}.json`);
}

function readJob(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeAtomic(path, body) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

export function threadOp(input) {
  if (!input || typeof input !== "object") {
    return fail("invalid_input");
  }
  if (!segment(input.thread_key) || !/^[a-f0-9]{16}$/.test(input.thread_key)) {
    return fail("bad_thread_key");
  }
  if (typeof input.state_dir !== "string" || input.state_dir.length === 0) {
    return fail("invalid_input");
  }
  if (input.op === "claim") {
    return claim(input);
  }
  if (input.op === "commit") {
    return commit(input);
  }
  if (input.op === "release") {
    return release(input);
  }
  return fail("invalid_input");
}

function claim(input) {
  if (!segment(input.owner) || !segment(input.repo) || typeof input.work_root !== "string" || !ledgerOk(input.ledger_path)) {
    return fail("invalid_input");
  }
  if (typeof input.request_text !== "string") {
    return fail("invalid_input");
  }
  const lock = takeLock(input.state_dir, input.thread_key);
  if (!lock.ok) {
    if (lock.reason === "busy") {
      try {
        return { ...lock, request_path: queueRequest(input) };
      } catch (error) {
        return fail(error.code || "claim_failed");
      }
    }
    return lock;
  }
  try {
    const seen = seenDir(input.state_dir, input.ledger_path);
    const request = requestPath(input.state_dir, input.thread_key, input.ledger_path);
    const threadDir = join(input.state_dir, "threads", input.thread_key);
    mkdirSync(join(threadDir, "requests"), { recursive: true });
    mkdirSync(join(input.state_dir, "jobs"), { recursive: true });
    let duplicate = false;
    mkdirSync(dirname(seen), { recursive: true });
    try {
      mkdirSync(seen);
      rmSync(seen, { recursive: true, force: true });
    } catch (error) {
      if (error.code === "EEXIST") {
        duplicate = true;
      } else {
        throw error;
      }
    }
    if (duplicate) {
      dropLock(lock.dir);
      return fail("duplicate");
    }
    let created = false;
    try {
      writeFileSync(request, input.request_text, { flag: "wx" });
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
    const job = readJob(jobPath(input.state_dir, input.thread_key));
    const running = Boolean(job && job.status === "running" && input.agent_alive === true);
    const action = running ? "steer" : "launch";
    let steerPath = null;
    const promptPath = join(threadDir, "prompt.md");
    if (action === "launch") {
      writeFileSync(promptPath, input.request_text);
    } else {
      const n = created ? Date.now() : "retry";
      steerPath = join(threadDir, `steer-${n}.md`);
      writeFileSync(steerPath, input.request_text);
    }
    return {
      ok: true,
      action,
      token: lock.token,
      request_path: request,
      prompt_path: promptPath,
      steer_path: steerPath,
      job_path: jobPath(input.state_dir, input.thread_key),
      work_dir: join(input.work_root, input.owner, input.repo, input.thread_key),
      agent_name: input.agent_name ?? null,
      reply_target: input.reply_target ?? null,
    };
  } catch (error) {
    dropLock(lock.dir);
    return fail(error.code || "claim_failed");
  }
}

function commit(input) {
  if (!ledgerOk(input.ledger_path) || typeof input.token !== "string") {
    return fail("invalid_input");
  }
  const lock = checkToken(input.state_dir, input.thread_key, input.token);
  if (!lock.ok) {
    return lock;
  }
  const seen = seenDir(input.state_dir, input.ledger_path);
  mkdirSync(seen, { recursive: true });
  const path = jobPath(input.state_dir, input.thread_key);
  mkdirSync(join(input.state_dir, "jobs"), { recursive: true });
  const previous = readJob(path) ?? {};
  const job = {
    ...previous,
    agent_name: input.agent_name ?? previous.agent_name ?? null,
    reply_target: input.reply_target ?? previous.reply_target ?? null,
    status: "running",
    started: previous.started ?? new Date().toISOString(),
  };
  writeAtomic(path, `${JSON.stringify(job)}\n`);
  dropLock(lock.dir);
  return { ok: true, status: "running", job_path: path };
}

function release(input) {
  if (typeof input.token !== "string") {
    return fail("invalid_input");
  }
  const lock = checkToken(input.state_dir, input.thread_key, input.token);
  if (!lock.ok) {
    return lock;
  }
  const path = jobPath(input.state_dir, input.thread_key);
  const previous = readJob(path) ?? {};
  mkdirSync(join(input.state_dir, "jobs"), { recursive: true });
  writeAtomic(
    path,
    `${JSON.stringify({ ...previous, status: "failed", agent_name: input.agent_name ?? previous.agent_name ?? null })}\n`,
  );
  dropLock(lock.dir);
  return { ok: true, status: "failed", job_path: path };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stdout.write(`${JSON.stringify(fail("invalid_json"))}\n`);
    process.exitCode = 1;
    return;
  }
  if (process.argv[2]) {
    input = { ...input, op: process.argv[2] };
  }
  process.stdout.write(`${JSON.stringify(threadOp(input))}\n`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
