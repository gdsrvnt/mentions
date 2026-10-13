import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { threadOp } from "../scripts/thread-state.mjs";

const ledger = ["issue_comment", "a".repeat(64), "b".repeat(64)];
const otherLedger = ["issue_comment", "c".repeat(64), "d".repeat(64)];

function scratch() {
  return mkdtempSync(join(tmpdir(), "mentions-thread-"));
}

function base(dir, extra = {}) {
  return {
    state_dir: join(dir, "state"),
    work_root: join(dir, "work"),
    thread_key: "0123456789abcdef",
    owner: "octo-org",
    repo: "sandbox",
    ledger_path: ledger,
    request_text: "Request from octo-user\n@helper-bot look",
    agent_name: "01234567-issue-4",
    reply_target: { kind: "issue-comment", number: 4 },
    ...extra,
  };
}

test("a second claim waits behind the lease, and a failed launch can retry", () => {
  const dir = scratch();
  const first = threadOp({ ...base(dir), op: "claim" });
  const second = threadOp({ ...base(dir), op: "claim" });
  assert.equal(first.ok, true);
  assert.equal(first.action, "launch");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "busy");
  const released = threadOp({ ...base(dir), op: "release", token: first.token });
  assert.equal(released.ok, true);
  assert.equal(released.status, "failed");
  const retry = threadOp({ ...base(dir), op: "claim" });
  assert.equal(retry.ok, true);
  assert.equal(retry.action, "launch");
  rmSync(dir, { recursive: true, force: true });
});

test("commit records the ledger, and a replay is a duplicate", () => {
  const dir = scratch();
  const claimed = threadOp({ ...base(dir), op: "claim" });
  const committed = threadOp({ ...base(dir), op: "commit", token: claimed.token });
  assert.equal(committed.status, "running");
  const job = JSON.parse(readFileSync(claimed.job_path, "utf8"));
  assert.equal(job.status, "running");
  const again = threadOp({ ...base(dir), op: "claim" });
  assert.equal(again.reason, "duplicate");
  rmSync(dir, { recursive: true, force: true });
});

test("a later comment on the same thread steers and keeps the first request", () => {
  const dir = scratch();
  const claimed = threadOp({ ...base(dir), op: "claim" });
  threadOp({ ...base(dir), op: "commit", token: claimed.token });
  const firstText = readFileSync(claimed.request_path, "utf8");
  const steer = threadOp({
    ...base(dir),
    op: "claim",
    ledger_path: otherLedger,
    request_text: "Request from octo-user\n@helper-bot again",
  });
  assert.equal(steer.action, "steer");
  assert.equal(readFileSync(claimed.request_path, "utf8"), firstText);
  assert.match(readFileSync(steer.request_path, "utf8"), /again/);
  rmSync(dir, { recursive: true, force: true });
});

test("work directories include the owner", () => {
  const dir = scratch();
  const left = threadOp({ ...base(dir), op: "claim" });
  threadOp({ ...base(dir), op: "release", token: left.token });
  const right = threadOp({
    ...base(dir, { thread_key: "fedcba9876543210", owner: "octo", repo: "org-sandbox" }),
    op: "claim",
  });
  assert.match(left.work_dir, /octo-org\/sandbox$/);
  assert.match(right.work_dir, /octo\/org-sandbox$/);
  assert.notEqual(left.work_dir, right.work_dir);
  rmSync(dir, { recursive: true, force: true });
});

test("a stale lease can be recovered", () => {
  const dir = scratch();
  const state = join(dir, "state");
  const lock = join(state, "locks", "0123456789abcdef");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "lease.json"), `${JSON.stringify({ token: "old", pid: 1, expires: 1 })}\n`);
  const claimed = threadOp({ ...base(dir), op: "claim" });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.action, "launch");
  rmSync(dir, { recursive: true, force: true });
});

test("two claims at once produce one launch and one busy result", async () => {
  const dir = scratch();
  const script = fileURLToPath(new URL("../scripts/thread-state.mjs", import.meta.url));
  const input = JSON.stringify({ ...base(dir), op: "claim" });
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        if (status !== 0) {
          reject(new Error(err || out));
          return;
        }
        resolve(JSON.parse(out));
      });
      child.stdin.end(input);
    });
  const decisions = await Promise.all([run(), run()]);
  const oks = decisions.filter((row) => row.ok);
  const busy = decisions.filter((row) => row.reason === "busy");
  assert.equal(oks.length, 1);
  assert.equal(busy.length, 1);
  assert.equal(oks[0].action, "launch");
  rmSync(dir, { recursive: true, force: true });
});
