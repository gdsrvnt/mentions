import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { routeEvent } from "../scripts/route-event.mjs";
import { threadOp } from "../scripts/thread-state.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const fixtures = join(root, "fixtures");

function load(name) {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

function canonicalEvent(eventName) {
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return "pull_request";
  }
  return eventName;
}

function threadKey(owner, repo, kind, number) {
  return createHash("sha256")
    .update(JSON.stringify([owner.toLowerCase(), repo.toLowerCase(), kind, String(number)]))
    .digest("hex")
    .slice(0, 16);
}

function requestEvent(id, createdAt, actor, reviewer, typename = "ReviewRequestedEvent") {
  return {
    __typename: typename,
    id,
    createdAt,
    actor: { login: actor },
    requestedReviewer: { __typename: "User", login: reviewer },
  };
}

function timeline(repo, number, nodes) {
  const [owner, name] = repo.split("/");
  return { id: `PR_${number}`, number, repository: { name, owner: { login: owner } }, timelineItems: { nodes } };
}

function apiObject(input) {
  const payload = input.payload;
  const repo = payload.repository.full_name;
  const eventName = input.event_name;
  if (payload.action === "review_requested") {
    return timeline(repo, payload.pull_request.number, [
      requestEvent("RRE_1", "2026-10-12T07:00:00Z", payload.sender.login, payload.requested_reviewer.login),
    ]);
  }
  if (eventName === "issues") {
    const issue = payload.issue;
    return {
      ...issue,
      html_url: issue.html_url ?? `https://github.com/${repo}/issues/${issue.number}`,
      url: issue.url ?? `https://api.github.com/repos/${repo}/issues/${issue.number}`,
    };
  }
  if (eventName === "issue_comment") {
    const onPull = Boolean(payload.issue?.pull_request);
    const html = onPull
      ? `https://github.com/${repo}/pull/${payload.issue.number}#issuecomment-${payload.comment.id}`
      : `https://github.com/${repo}/issues/${payload.issue.number}#issuecomment-${payload.comment.id}`;
    return {
      ...payload.comment,
      issue_url: `https://api.github.com/repos/${repo}/issues/${payload.issue.number}`,
      html_url: payload.comment.html_url ?? html,
    };
  }
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const pull = payload.pull_request;
    return {
      ...pull,
      html_url: pull.html_url ?? `https://github.com/${repo}/pull/${pull.number}`,
      url: pull.url ?? `https://api.github.com/repos/${repo}/pulls/${pull.number}`,
      base: pull.base ?? { ref: "main" },
    };
  }
  if (eventName === "pull_request_review") {
    return {
      ...payload.review,
      pull_request_url: `https://api.github.com/repos/${repo}/pulls/${payload.pull_request.number}`,
    };
  }
  if (eventName === "pull_request_review_comment") {
    return {
      ...payload.comment,
      pull_request_url: `https://api.github.com/repos/${repo}/pulls/${payload.pull_request.number}`,
      html_url:
        payload.comment.html_url ??
        `https://github.com/${repo}/pull/${payload.pull_request.number}#discussion_r${payload.comment.id}`,
    };
  }
  if (eventName === "discussion") {
    const discussion = payload.discussion;
    return {
      ...discussion,
      html_url: discussion.html_url ?? `https://github.com/${repo}/discussions/${discussion.number}`,
    };
  }
  if (eventName === "discussion_comment") {
    return {
      ...payload.comment,
      number: payload.discussion.number,
      discussion_node_id: payload.discussion.node_id,
    };
  }
  throw new Error(eventName);
}

function finish(input) {
  const fetched = input.fetched ?? apiObject(input);
  if (!fetched.user && !fetched.author) {
    fetched.user = { login: input.payload.sender.login };
  }
  return routeEvent({ ...input, fetched });
}

const accepts = {
  "issues.json": { owner: "octo-org", repo: "sandbox", kind: "issue", number: 12, reply: "issue-comment" },
  "issue-comment.json": { owner: "octo-org", repo: "sandbox", kind: "issue", number: 4, reply: "issue-comment" },
  "issue-comment-on-pr.json": { owner: "octo-org", repo: "sandbox", kind: "pr", number: 7, reply: "issue-comment" },
  "pull-request-target.json": { owner: "octo-org", repo: "sandbox", kind: "pr", number: 7, reply: "issue-comment" },
  "fork-pull-request.json": { owner: "octo-org", repo: "sandbox", kind: "pr", number: 7, reply: "issue-comment" },
  "pull-request-review.json": { owner: "octo-org", repo: "sandbox", kind: "pr", number: 7, reply: "issue-comment" },
  "review-requested.json": {
    owner: "octo-org",
    repo: "sandbox",
    kind: "pr",
    number: 7,
    reply: "issue-comment",
    ledger: "review_requested",
  },
  "pull-request-review-comment.json": {
    owner: "octo-org",
    repo: "sandbox",
    kind: "pr",
    number: 7,
    reply: "review-comment-reply",
  },
  "discussion.json": { owner: "octo-org", repo: "sandbox", kind: "discussion", number: 3, reply: "discussion-comment" },
  "discussion-comment.json": {
    owner: "octo-org",
    repo: "sandbox",
    kind: "discussion",
    number: 3,
    reply: "discussion-comment",
  },
  "sender-case.json": { owner: "octo-org", repo: "sandbox", kind: "issue", number: 12, reply: "issue-comment" },
};

const rejects = {
  "wrong-repo.json": "wrong_repo",
  "wrong-sender.json": "wrong_sender",
  "mention-boundary.json": "no_mention",
  "fork-review.json": "fork_review",
  "no-mention.json": "no_mention",
  "commit-comment.json": "unsupported_event",
  "duplicate-issue.json": "duplicate",
  "review-request-other-reviewer.json": "no_review_request",
};

test("fixture files cover the event types and the reject cases", () => {
  const names = readdirSync(fixtures).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, [...Object.keys(accepts), ...Object.keys(rejects)].sort());
});

for (const [name, want] of Object.entries(accepts)) {
  test(`accepts ${name}`, () => {
    const input = load(name);
    const pending = routeEvent(input);
    assert.equal(pending.accept, false);
    assert.equal(pending.reason, "needs_fetch");
    assert.ok(pending.text_source);
    const decision = finish(input);
    assert.equal(decision.accept, true);
    assert.equal(decision.reason, "ok");
    assert.equal(decision.thread_key, threadKey(want.owner, want.repo, want.kind, want.number));
    assert.equal(decision.reply_target.kind, want.reply);
    if (want.reply === "discussion-comment") {
      assert.equal(typeof decision.reply_target.discussion_id, "string");
    } else {
      assert.equal(decision.reply_target.number, want.number);
    }
    assert.match(decision.agent_name, new RegExp(`^[a-f0-9]{8}-${want.kind}-${want.number}$`));
    assert.notEqual(decision.agent_name, decision.thread_key);
    const ledgerEvent = want.ledger ?? canonicalEvent(input.event_name);
    assert.equal(decision.ledger.event_name, ledgerEvent);
    assert.equal(decision.ledger_path.length, 3);
    assert.equal(decision.ledger_path[0], ledgerEvent);
    for (const segment of decision.ledger_path.slice(1)) {
      assert.match(segment, /^[a-f0-9]{64}$/);
    }
  });
}

for (const [name, reason] of Object.entries(rejects)) {
  test(`rejects ${name}`, () => {
    const input = load(name);
    const decision = reason === "duplicate" ? finish(input) : routeEvent(input);
    assert.equal(decision.accept, false);
    assert.equal(decision.reason, reason);
    assert.equal(decision.thread_key, null);
    assert.equal(decision.agent_name, null);
  });
}

test("an empty repos list accepts the repository named in the payload", () => {
  const input = load("issues.json");
  input.config = { ...input.config, repos: [] };
  const decision = finish(input);
  assert.equal(decision.accept, true);
  assert.equal(decision.thread_key, threadKey("octo-org", "sandbox", "issue", 12));
});

test("agent names differ when only the repository differs", () => {
  const left = load("issues.json");
  const right = structuredClone(left);
  right.payload.repository = { full_name: "octo-org/other" };
  right.config = { ...right.config, repos: [] };
  const a = finish(left);
  const b = finish(right);
  assert.equal(a.accept, true);
  assert.equal(b.accept, true);
  assert.notEqual(a.agent_name, b.agent_name);
  assert.equal(b.thread_key, threadKey("octo-org", "other", "issue", 12));
});

test("owner and repo punctuation do not share an agent", () => {
  const left = load("issues.json");
  const right = structuredClone(left);
  right.payload.repository = { full_name: "octo/org-sandbox" };
  right.config = { ...right.config, repos: [] };
  const dotted = structuredClone(left);
  dotted.payload.repository = { full_name: "octo.org/sandbox" };
  dotted.config = { ...dotted.config, repos: [] };
  const a = finish(left);
  const b = finish(right);
  const c = finish(dotted);
  assert.equal(a.thread_key, threadKey("octo-org", "sandbox", "issue", 12));
  assert.notEqual(a.thread_key, b.thread_key);
  assert.notEqual(a.agent_name, b.agent_name);
  assert.notEqual(a.thread_key, c.thread_key);
  assert.notEqual(a.agent_name, c.agent_name);
});

test("a forged webhook timestamp does not open a new ledger entry", () => {
  const input = load("duplicate-issue.json");
  const fetched = structuredClone(apiObject(input));
  input.payload.issue.updated_at = "2099-01-01T00:00:00Z";
  input.payload.issue.node_id = "../../../outside-seen";
  const decision = finish({ ...input, fetched });
  assert.equal(decision.accept, false);
  assert.equal(decision.reason, "duplicate");
});

test("a forged parent thread does not change the reply target", () => {
  const input = load("issue-comment.json");
  const fetched = structuredClone(apiObject(input));
  input.payload.issue.number = 99;
  const decision = finish({ ...input, fetched });
  assert.equal(decision.accept, true);
  assert.equal(decision.reply_target.number, 4);
  assert.equal(decision.thread_key, threadKey("octo-org", "sandbox", "issue", 4));
  assert.equal(decision.text_source.path, "/repos/octo-org/sandbox/issues/comments/1001");
});

test("a traversal node id is stored as a hash", () => {
  const input = load("issue-comment.json");
  const decision = finish({
    ...input,
    fetched: { ...apiObject(input), node_id: "../../../outside-seen" },
  });
  assert.equal(decision.accept, true);
  assert.equal(decision.ledger.node_id, "../../../outside-seen");
  for (const segment of decision.ledger_path) {
    assert.equal(segment.includes(".."), false);
    assert.equal(segment.includes("/"), false);
  }
});

test("a review without updated_at still accepts on submitted_at", () => {
  const input = load("pull-request-review.json");
  assert.equal(input.payload.review.updated_at, undefined);
  const decision = finish(input);
  assert.equal(decision.accept, true);
  assert.match(decision.ledger.updated_at, /^2026-10-12T03:00:00Z#[a-f0-9]{16}$/);
});

test("a changed review body is not a duplicate of the submitted revision", () => {
  const input = load("pull-request-review.json");
  const first = finish(input);
  const again = finish({
    ...input,
    seen: [first.ledger],
    fetched: { ...apiObject(input), body: "@helper-bot edited" },
  });
  assert.equal(again.accept, true);
  assert.notEqual(again.ledger.updated_at, first.ledger.updated_at);
});

test("a changed updated_at is not a duplicate", () => {
  const input = load("duplicate-issue.json");
  const decision = finish({
    ...input,
    fetched: { ...apiObject(input), updated_at: "2026-10-12T09:00:00Z" },
  });
  assert.equal(decision.accept, true);
  assert.equal(decision.ledger.updated_at, "2026-10-12T09:00:00Z");
});

test("the review comment reply target carries the comment id", () => {
  const decision = finish(load("pull-request-review-comment.json"));
  assert.equal(decision.reply_target.comment_id, 55);
  assert.equal(decision.text_source.path, "/repos/octo-org/sandbox/pulls/comments/55");
});

test("the issue comment text source is the comment, not the issue", () => {
  const decision = finish(load("issue-comment-on-pr.json"));
  assert.equal(decision.text_source.path, "/repos/octo-org/sandbox/issues/comments/1001");
});

test("a review request is read from the timeline, not the webhook", () => {
  const input = load("review-requested.json");
  const pending = routeEvent(input);
  assert.equal(pending.reason, "needs_fetch");
  assert.deepEqual(pending.text_source, {
    api: "graphql",
    owner: "octo-org",
    name: "sandbox",
    number: 7,
    what: "review_requested",
    node_id: "PR_7",
  });
  const route = (nodes, repo = "octo-org/sandbox") => routeEvent({ ...input, fetched: timeline(repo, 7, nodes) });
  const newest = route([
    requestEvent("RRE_1", "2026-10-12T07:00:00Z", "octo-user", "helper-bot"),
    requestEvent("RRE_2", "2026-10-12T07:05:00Z", "octo-user", "octo-reviewer"),
    requestEvent("RRE_3", "2026-10-12T07:10:00Z", "Octo-User", "Helper-Bot"),
    requestEvent("RRE_4", "2026-10-12T07:15:00Z", "mallory", "helper-bot"),
  ]);
  assert.equal(newest.accept, true);
  assert.deepEqual(newest.ledger, {
    event_name: "review_requested",
    node_id: "RRE_3",
    updated_at: "2026-10-12T07:10:00Z",
  });
  assert.equal(route([requestEvent("RRE_4", "2026-10-12T07:15:00Z", "mallory", "helper-bot")]).reason, "wrong_sender");
  assert.equal(
    route([requestEvent("RRE_2", "2026-10-12T07:05:00Z", "octo-user", "octo-reviewer")]).reason,
    "no_review_request",
  );
  assert.equal(
    route([requestEvent("RRR_5", "2026-10-12T07:20:00Z", "octo-user", "helper-bot", "ReviewRequestRemovedEvent")]).reason,
    "no_review_request",
  );
  assert.equal(route([requestEvent("RRE_1", "2026-10-12T07:00:00Z", "octo-user", "helper-bot")], "octo-org/other").reason, "wrong_repo");
  const noRepo = timeline("octo-org/sandbox", 7, [requestEvent("RRE_1", "2026-10-12T07:00:00Z", "octo-user", "helper-bot")]);
  delete noRepo.repository;
  assert.equal(routeEvent({ ...input, fetched: noRepo }).reason, "wrong_repo");
});

test("a review request comes only from the trigger user, for the bot", () => {
  const input = load("review-requested.json");
  const stranger = structuredClone(input);
  stranger.payload.sender.login = "mallory";
  assert.equal(routeEvent(stranger).reason, "wrong_sender");
  const team = structuredClone(input);
  delete team.payload.requested_reviewer;
  team.payload.requested_team = { slug: "helper-bot" };
  assert.equal(routeEvent(team).reason, "no_review_request");
  const opened = structuredClone(input);
  opened.payload.action = "opened";
  assert.equal(routeEvent(opened).reason, "no_mention");
});

test("a re-requested review is a new delivery and a replay is a duplicate", () => {
  const input = load("review-requested.json");
  const first = finish(input);
  assert.equal(first.accept, true);
  const replay = finish({ ...input, event_name: "pull_request", seen: [first.ledger] });
  assert.equal(replay.accept, false);
  assert.equal(replay.reason, "duplicate");
  const again = routeEvent({
    ...input,
    seen: [first.ledger],
    fetched: timeline("octo-org/sandbox", 7, [
      requestEvent("RRE_1", "2026-10-12T07:00:00Z", "octo-user", "helper-bot"),
      requestEvent("RRE_9", "2026-10-13T07:00:00Z", "octo-user", "helper-bot"),
    ]),
  });
  assert.equal(again.accept, true);
  assert.equal(again.ledger.node_id, "RRE_9");
  assert.equal(again.thread_key, first.thread_key);
  assert.notDeepEqual(again.ledger_path, first.ledger_path);
});

test("a pull_request alias is the same delivery as pull_request_target", () => {
  const input = load("pull-request-target.json");
  const first = finish(input);
  assert.equal(first.accept, true);
  assert.equal(first.ledger_path[0], "pull_request");
  const alias = finish({ ...input, event_name: "pull_request", seen: [first.ledger] });
  assert.equal(alias.accept, false);
  assert.equal(alias.reason, "duplicate");
  const dir = mkdtempSync(join(tmpdir(), "mentions-alias-"));
  const claimed = threadOp({
    op: "claim",
    state_dir: join(dir, "state"),
    work_root: join(dir, "work"),
    thread_key: first.thread_key,
    owner: "octo-org",
    repo: "sandbox",
    ledger_path: first.ledger_path,
    request_text: "Request from octo-user",
    agent_name: first.agent_name,
    reply_target: first.reply_target,
  });
  assert.equal(claimed.ok, true);
  threadOp({
    op: "commit",
    state_dir: join(dir, "state"),
    thread_key: first.thread_key,
    token: claimed.token,
    ledger_path: first.ledger_path,
    agent_name: first.agent_name,
    reply_target: first.reply_target,
  });
  const replay = threadOp({
    op: "claim",
    state_dir: join(dir, "state"),
    work_root: join(dir, "work"),
    thread_key: first.thread_key,
    owner: "octo-org",
    repo: "sandbox",
    ledger_path: first.ledger_path,
    request_text: "Request from octo-user",
    agent_name: first.agent_name,
    reply_target: first.reply_target,
  });
  assert.equal(replay.reason, "duplicate");
  rmSync(dir, { recursive: true, force: true });
});

test("a forged pull_request flag does not change the thread kind", () => {
  const input = load("issue-comment.json");
  const fetched = structuredClone(apiObject(input));
  fetched.html_url = "https://github.com/octo-org/sandbox/issues/4#issuecomment-1001";
  input.payload.issue.pull_request = { url: "https://api.github.com/repos/octo-org/sandbox/pulls/4" };
  const decision = finish({ ...input, fetched });
  assert.equal(decision.accept, true);
  assert.equal(decision.thread_key, threadKey("octo-org", "sandbox", "issue", 4));
  const forged = structuredClone(input);
  forged.payload.issue.pull_request = { url: "https://api.github.com/repos/octo-org/sandbox/pulls/4" };
  const other = finish({ ...forged, fetched });
  assert.equal(other.thread_key, decision.thread_key);
});

test("a GraphQL discussion comment is accepted without webhook fields", () => {
  const input = load("discussion-comment.json");
  const fetched = {
    id: "DC_8",
    updatedAt: "2026-10-12T06:00:00Z",
    body: "@helper-bot one more question",
    author: { login: "octo-user" },
    discussion: {
      id: "D_3",
      number: 3,
      repository: { name: "sandbox", owner: { login: "octo-org" } },
    },
  };
  const decision = finish({ ...input, fetched });
  assert.equal(decision.accept, true);
  assert.equal(decision.reason, "ok");
  assert.equal(decision.thread_key, threadKey("octo-org", "sandbox", "discussion", 3));
  assert.equal(decision.reply_target.discussion_id, "D_3");
  assert.equal(decision.reply_target.reply_to_id, "DC_8");
});

test("a GraphQL discussion is accepted without REST field names", () => {
  const input = load("discussion.json");
  const fetched = {
    id: "D_3",
    number: 3,
    title: "Hello @helper-bot",
    body: "How does install work?",
    updatedAt: "2026-10-12T05:00:00Z",
    author: { login: "octo-user" },
    repository: { name: "sandbox", owner: { login: "octo-org" } },
  };
  const decision = finish({ ...input, fetched });
  assert.equal(decision.accept, true);
  assert.equal(decision.thread_key, threadKey("octo-org", "sandbox", "discussion", 3));
  assert.equal(decision.reply_target.discussion_id, "D_3");
  assert.equal(decision.reply_target.reply_to_id, null);
});

test("a pull request replayed as an issues event is not a second delivery", () => {
  const config = {
    trigger_user: "octo-user",
    bot_handle: "helper-bot",
    repos: ["octo-org/sandbox"],
  };
  const repository = { full_name: "octo-org/sandbox" };
  const sender = { login: "octo-user" };
  const revision = {
    number: 7,
    title: "Parser",
    body: "@helper-bot please review",
    node_id: "PR_7",
    updated_at: "2026-10-12T02:00:00Z",
    user: { login: "octo-user" },
  };
  const pull = {
    ...revision,
    html_url: "https://github.com/octo-org/sandbox/pull/7",
    url: "https://api.github.com/repos/octo-org/sandbox/pulls/7",
    issue_url: "https://api.github.com/repos/octo-org/sandbox/issues/7",
    head: { ref: "parser", repo: { fork: false } },
    base: { ref: "main" },
  };
  const asIssue = {
    ...revision,
    html_url: "https://github.com/octo-org/sandbox/pull/7",
    url: "https://api.github.com/repos/octo-org/sandbox/issues/7",
    pull_request: {
      url: "https://api.github.com/repos/octo-org/sandbox/pulls/7",
      html_url: "https://github.com/octo-org/sandbox/pull/7",
    },
  };
  const honest = routeEvent({
    event_name: "pull_request_target",
    config,
    payload: { repository, sender, pull_request: pull },
    fetched: pull,
  });
  const issueWrap = routeEvent({
    event_name: "issues",
    config,
    payload: { repository, sender, issue: asIssue },
    fetched: asIssue,
  });
  const pullUnderIssues = routeEvent({
    event_name: "issues",
    config,
    payload: { repository, sender, issue: pull },
    fetched: pull,
  });
  const issueShapeUnderPull = routeEvent({
    event_name: "pull_request_target",
    config,
    payload: { repository, sender, pull_request: asIssue },
    fetched: asIssue,
  });
  assert.equal(honest.accept, true);
  assert.equal(honest.ledger.event_name, "pull_request");
  assert.equal(honest.thread_key, threadKey("octo-org", "sandbox", "pr", 7));
  assert.equal(issueWrap.accept, false);
  assert.equal(issueWrap.reason, "missing_object");
  assert.equal(issueWrap.thread_key, null);
  assert.equal(issueWrap.ledger_path, null);
  assert.equal(pullUnderIssues.accept, false);
  assert.equal(pullUnderIssues.reason, "missing_object");
  assert.equal(issueShapeUnderPull.accept, true);
  assert.equal(issueShapeUnderPull.thread_key, honest.thread_key);
  assert.equal(issueShapeUnderPull.agent_name, honest.agent_name);
  assert.deepEqual(issueShapeUnderPull.ledger_path, honest.ledger_path);
  assert.deepEqual(issueShapeUnderPull.reply_target, honest.reply_target);

  const dir = mkdtempSync(join(tmpdir(), "mentions-pr-as-issue-"));
  const claim = (label, decision) =>
    threadOp({
      op: "claim",
      state_dir: join(dir, label),
      work_root: join(dir, "work"),
      thread_key: decision.thread_key,
      owner: "octo-org",
      repo: "sandbox",
      ledger_path: decision.ledger_path,
      request_text: "Request from octo-user",
      agent_name: decision.agent_name,
      reply_target: decision.reply_target,
    });
  const first = claim("concurrent", honest);
  const second = claim("concurrent", issueShapeUnderPull);
  assert.equal(first.action, "launch");
  assert.equal(second.reason, "busy");
  const committed = claim("committed", honest);
  assert.equal(
    threadOp({
      op: "commit",
      state_dir: join(dir, "committed"),
      thread_key: honest.thread_key,
      token: committed.token,
      ledger_path: honest.ledger_path,
      agent_name: honest.agent_name,
      reply_target: honest.reply_target,
    }).ok,
    true,
  );
  assert.equal(claim("committed", issueShapeUnderPull).reason, "duplicate");
  rmSync(dir, { recursive: true, force: true });
});

test("stdin CLI prints one JSON decision", () => {
  const script = join(root, "../scripts/route-event.mjs");
  const input = load("issues.json");
  input.fetched = apiObject(input);
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.accept, true);
  assert.equal(decision.thread_key, threadKey("octo-org", "sandbox", "issue", 12));
});
