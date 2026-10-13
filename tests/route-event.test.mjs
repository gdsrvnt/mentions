import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { routeEvent } from "../scripts/route-event.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const fixtures = join(root, "fixtures");

function load(name) {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

const accepts = {
  "issues.json": { thread_key: "octo-org-sandbox-issue-12", kind: "issue", number: 12, reply: "issue-comment" },
  "issue-comment.json": { thread_key: "octo-org-sandbox-issue-4", kind: "issue", number: 4, reply: "issue-comment" },
  "issue-comment-on-pr.json": { thread_key: "octo-org-sandbox-pr-7", kind: "pr", number: 7, reply: "issue-comment" },
  "pull-request-target.json": { thread_key: "octo-org-sandbox-pr-7", kind: "pr", number: 7, reply: "issue-comment" },
  "pull-request-review.json": { thread_key: "octo-org-sandbox-pr-7", kind: "pr", number: 7, reply: "issue-comment" },
  "pull-request-review-comment.json": {
    thread_key: "octo-org-sandbox-pr-7",
    kind: "pr",
    number: 7,
    reply: "review-comment-reply",
  },
  "discussion.json": { thread_key: "octo-org-sandbox-discussion-3", kind: "discussion", number: 3, reply: "discussion-comment" },
  "discussion-comment.json": {
    thread_key: "octo-org-sandbox-discussion-3",
    kind: "discussion",
    number: 3,
    reply: "discussion-comment",
  },
  "sender-case.json": { thread_key: "octo-org-sandbox-issue-12", kind: "issue", number: 12, reply: "issue-comment" },
};

const rejects = {
  "wrong-repo.json": "wrong_repo",
  "wrong-sender.json": "wrong_sender",
  "mention-boundary.json": "no_mention",
  "fork-review.json": "fork_review",
  "no-mention.json": "no_mention",
  "commit-comment.json": "unsupported_event",
  "duplicate-issue.json": "duplicate",
};

test("fixture files cover the event types and the reject cases", () => {
  const names = readdirSync(fixtures).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, [...Object.keys(accepts), ...Object.keys(rejects)].sort());
});

for (const [name, want] of Object.entries(accepts)) {
  test(`accepts ${name}`, () => {
    const decision = routeEvent(load(name));
    assert.equal(decision.accept, true);
    assert.equal(decision.reason, "ok");
    assert.equal(decision.thread_key, want.thread_key);
    assert.equal(decision.reply_target.kind, want.reply);
    if (want.reply === "discussion-comment") {
      assert.equal(typeof decision.reply_target.discussion_id, "string");
    } else {
      assert.equal(decision.reply_target.number, want.number);
    }
    assert.match(decision.agent_name, new RegExp(`^[a-f0-9]{8}-${want.kind}-${want.number}$`));
    assert.notEqual(decision.agent_name, decision.thread_key);
    assert.ok(decision.text_source);
    assert.equal(decision.ledger.event_name, load(name).event_name);
    assert.ok(decision.ledger.node_id);
  });
}

for (const [name, reason] of Object.entries(rejects)) {
  test(`rejects ${name}`, () => {
    const decision = routeEvent(load(name));
    assert.equal(decision.accept, false);
    assert.equal(decision.reason, reason);
    assert.equal(decision.thread_key, null);
    assert.equal(decision.agent_name, null);
  });
}

test("an empty repos list accepts the repository named in the payload", () => {
  const input = load("issues.json");
  input.config = { ...input.config, repos: [] };
  const decision = routeEvent(input);
  assert.equal(decision.accept, true);
  assert.equal(decision.thread_key, "octo-org-sandbox-issue-12");
});

test("agent names differ when only the repository differs", () => {
  const left = load("issues.json");
  const right = structuredClone(left);
  right.payload.repository = { full_name: "octo-org/other" };
  right.config = { ...right.config, repos: [] };
  const a = routeEvent(left);
  const b = routeEvent(right);
  assert.equal(a.accept, true);
  assert.equal(b.accept, true);
  assert.notEqual(a.agent_name, b.agent_name);
  assert.equal(b.thread_key, "octo-org-other-issue-12");
});

test("a changed updated_at is not a duplicate", () => {
  const input = load("duplicate-issue.json");
  input.payload.issue.updated_at = "2026-10-12T09:00:00Z";
  const decision = routeEvent(input);
  assert.equal(decision.accept, true);
});

test("the review comment reply target carries the comment id", () => {
  const decision = routeEvent(load("pull-request-review-comment.json"));
  assert.equal(decision.reply_target.comment_id, 55);
  assert.equal(decision.text_source.path, "/repos/octo-org/sandbox/pulls/comments/55");
});

test("the issue comment text source is the comment, not the issue", () => {
  const decision = routeEvent(load("issue-comment-on-pr.json"));
  assert.equal(decision.text_source.path, "/repos/octo-org/sandbox/issues/comments/1001");
});

test("stdin CLI prints one JSON decision", () => {
  const script = join(root, "../scripts/route-event.mjs");
  const result = spawnSync(process.execPath, [script], {
    input: readFileSync(join(fixtures, "issues.json")),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.accept, true);
  assert.equal(decision.thread_key, "octo-org-sandbox-issue-12");
});
