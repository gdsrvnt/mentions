#!/usr/bin/env node
// Decide whether a GitHub webhook event is a mention this install should handle.
// stdin: { event_name, payload, config, seen?, fetched? }
// stdout: { accept, reason, thread_key, agent_name, text_source, reply_target, ledger, ledger_path }
// A final accept requires fetched, the GitHub API object. Payload fields do not set the ledger or the thread.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HANDLED = new Set([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
  "discussion",
  "discussion_comment",
]);

function reject(reason, textSource = null) {
  return {
    accept: false,
    reason,
    thread_key: null,
    agent_name: null,
    text_source: textSource,
    reply_target: null,
    ledger: null,
    ledger_path: null,
  };
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

function mentionsHandle(text, handle) {
  const escaped = String(handle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])@${escaped}([^A-Za-z0-9_-]|$)`, "i");
  return pattern.test(String(text ?? ""));
}

function textOf(...parts) {
  return parts.filter((part) => typeof part === "string").join("\n");
}

function positiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function splitRepo(fullName) {
  const slash = String(fullName).indexOf("/");
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

function identityHash(owner, repo, kind, number) {
  return createHash("sha256")
    .update(JSON.stringify([lower(owner), lower(repo), kind, String(number)]))
    .digest("hex");
}

function threadKey(owner, repo, kind, number) {
  return identityHash(owner, repo, kind, number).slice(0, 16);
}

function agentName(owner, repo, kind, number) {
  const hash = identityHash(owner, repo, kind, number).slice(0, 8);
  const name = `${hash}-${kind}-${number}`;
  return name.length <= 32 ? name : hash;
}

function pathSegment(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function rest(fullName, path) {
  return { api: "rest", method: "GET", path: `/repos/${fullName}${path}` };
}

function graphql(fullName, number, what, nodeId) {
  const { owner, repo } = splitRepo(fullName);
  return {
    api: "graphql",
    owner,
    name: repo,
    number,
    what,
    node_id: nodeId ?? null,
  };
}

function revisionOf(node) {
  if (!node || typeof node !== "object" || typeof node.node_id !== "string" || node.node_id.length === 0) {
    return null;
  }
  if (typeof node.updated_at === "string" && node.updated_at.length > 0) {
    return { node_id: node.node_id, updated_at: node.updated_at };
  }
  if (typeof node.submitted_at === "string" && node.submitted_at.length > 0) {
    const body = typeof node.body === "string" ? node.body : "";
    const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
    return { node_id: node.node_id, updated_at: `${node.submitted_at}#${digest}` };
  }
  return null;
}

function isForkPullRequest(payload) {
  return payload?.pull_request?.head?.repo?.fork === true;
}

function numberFromUrl(url) {
  if (typeof url !== "string") {
    return null;
  }
  const match = url.match(/\/(?:issues|pulls)\/(\d+)(?:$|[?#])/);
  if (!match) {
    return null;
  }
  const number = Number(match[1]);
  return positiveInt(number) ? number : null;
}

function repoFromUrl(url) {
  if (typeof url !== "string") {
    return null;
  }
  const match = url.match(/\/repos\/([^/]+)\/([^/]+)\//);
  return match ? `${match[1]}/${match[2]}` : null;
}

function viewFor(eventName, payload) {
  const fullName = payload?.repository?.full_name;
  if (eventName === "issues") {
    const issue = payload.issue;
    return {
      text: textOf(issue?.title, issue?.body),
      kind: "issue",
      number: issue?.number,
      textSource: positiveInt(issue?.number) ? rest(fullName, `/issues/${issue.number}`) : null,
      fork: false,
    };
  }
  if (eventName === "issue_comment") {
    const comment = payload.comment;
    const issue = payload.issue;
    const kind = issue?.pull_request ? "pr" : "issue";
    return {
      text: textOf(comment?.body),
      kind,
      number: issue?.number,
      textSource: positiveInt(comment?.id) ? rest(fullName, `/issues/comments/${comment.id}`) : null,
      fork: false,
    };
  }
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const pull = payload.pull_request;
    return {
      text: textOf(pull?.title, pull?.body),
      kind: "pr",
      number: pull?.number,
      textSource: positiveInt(pull?.number) ? rest(fullName, `/pulls/${pull.number}`) : null,
      fork: false,
    };
  }
  if (eventName === "pull_request_review") {
    const pull = payload.pull_request;
    const review = payload.review;
    return {
      text: textOf(review?.body),
      kind: "pr",
      number: pull?.number,
      textSource:
        positiveInt(pull?.number) && positiveInt(review?.id)
          ? rest(fullName, `/pulls/${pull.number}/reviews/${review.id}`)
          : null,
      fork: isForkPullRequest(payload),
    };
  }
  if (eventName === "pull_request_review_comment") {
    const pull = payload.pull_request;
    const comment = payload.comment;
    return {
      text: textOf(comment?.body),
      kind: "pr",
      number: pull?.number,
      textSource: positiveInt(comment?.id) ? rest(fullName, `/pulls/comments/${comment.id}`) : null,
      fork: isForkPullRequest(payload),
    };
  }
  if (eventName === "discussion") {
    const discussion = payload.discussion;
    return {
      text: textOf(discussion?.title, discussion?.body),
      kind: "discussion",
      number: discussion?.number,
      textSource: positiveInt(discussion?.number)
        ? graphql(fullName, discussion.number, "discussion", discussion.node_id ?? null)
        : null,
      fork: false,
    };
  }
  if (eventName === "discussion_comment") {
    const discussion = payload.discussion;
    const comment = payload.comment;
    return {
      text: textOf(comment?.body),
      kind: "discussion",
      number: discussion?.number,
      textSource: positiveInt(discussion?.number)
        ? graphql(fullName, discussion.number, "discussion_comment", comment?.node_id ?? null)
        : null,
      fork: false,
    };
  }
  return null;
}

function parentNumber(eventName, fetched) {
  if (eventName === "issue_comment") {
    return numberFromUrl(fetched.issue_url);
  }
  if (eventName === "pull_request_review" || eventName === "pull_request_review_comment") {
    return numberFromUrl(fetched.pull_request_url);
  }
  return positiveInt(fetched.number) ? fetched.number : null;
}

function parentUrl(eventName, fetched) {
  if (eventName === "issue_comment") {
    return fetched.issue_url;
  }
  if (eventName === "pull_request_review" || eventName === "pull_request_review_comment") {
    return fetched.pull_request_url;
  }
  return null;
}

function replyFor(eventName, fetched, number) {
  if (eventName === "pull_request_review_comment") {
    if (!positiveInt(fetched.id)) {
      return null;
    }
    return { kind: "review-comment-reply", number, comment_id: fetched.id };
  }
  if (eventName === "discussion") {
    if (typeof fetched.node_id !== "string") {
      return null;
    }
    return { kind: "discussion-comment", discussion_id: fetched.node_id, reply_to_id: null };
  }
  if (eventName === "discussion_comment") {
    const discussionId = fetched.discussion_node_id || fetched.discussion?.node_id;
    if (typeof discussionId !== "string" || typeof fetched.node_id !== "string") {
      return null;
    }
    return { kind: "discussion-comment", discussion_id: discussionId, reply_to_id: fetched.node_id };
  }
  return { kind: "issue-comment", number };
}

function authorOf(fetched) {
  if (typeof fetched.user?.login === "string") {
    return fetched.user.login;
  }
  if (typeof fetched.author?.login === "string") {
    return fetched.author.login;
  }
  return null;
}

function configProblem(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return "invalid_config";
  }
  if (typeof config.trigger_user !== "string" || config.trigger_user.length === 0) {
    return "invalid_config";
  }
  if (typeof config.bot_handle !== "string" || config.bot_handle.length === 0) {
    return "invalid_config";
  }
  if (config.repos !== undefined && !Array.isArray(config.repos)) {
    return "invalid_config";
  }
  return null;
}

function repoAllowed(fullName, repos) {
  if (!Array.isArray(repos) || repos.length === 0) {
    return true;
  }
  return repos.some((repo) => lower(repo) === lower(fullName));
}

function duplicate(seen, eventName, identity) {
  if (!Array.isArray(seen) || !identity) {
    return false;
  }
  return seen.some(
    (row) =>
      row &&
      row.event_name === eventName &&
      row.node_id === identity.node_id &&
      row.updated_at === identity.updated_at,
  );
}

export function routeEvent(input) {
  if (!input || typeof input !== "object") {
    return reject("invalid_config");
  }
  const problem = configProblem(input.config);
  if (problem) {
    return reject(problem);
  }
  const eventName = input.event_name;
  if (!HANDLED.has(eventName)) {
    return reject("unsupported_event");
  }
  const payload = input.payload;
  if (!payload || typeof payload !== "object") {
    return reject("missing_payload");
  }
  const fullName = payload.repository?.full_name;
  if (typeof fullName !== "string" || !fullName.includes("/")) {
    return reject("missing_repo");
  }
  if (!repoAllowed(fullName, input.config.repos)) {
    return reject("wrong_repo");
  }
  const sender = payload.sender?.login;
  if (typeof sender !== "string" || lower(sender) !== lower(input.config.trigger_user)) {
    return reject("wrong_sender");
  }
  const view = viewFor(eventName, payload);
  if (!view) {
    return reject("unsupported_event");
  }
  if (view.fork) {
    return reject("fork_review");
  }
  if (!mentionsHandle(view.text, input.config.bot_handle)) {
    return reject("no_mention");
  }
  if (!positiveInt(view.number) || !view.textSource) {
    return reject("missing_object");
  }
  if (!input.fetched) {
    return reject("needs_fetch", view.textSource);
  }
  const fetched = input.fetched;
  if (!fetched || typeof fetched !== "object" || Array.isArray(fetched)) {
    return reject("missing_object", view.textSource);
  }
  const linkedRepo = repoFromUrl(parentUrl(eventName, fetched));
  if (linkedRepo && lower(linkedRepo) !== lower(fullName)) {
    return reject("wrong_repo");
  }
  const author = authorOf(fetched);
  if (typeof author !== "string" || lower(author) !== lower(input.config.trigger_user)) {
    return reject("wrong_sender");
  }
  const fetchedText = textOf(fetched.title, fetched.body);
  if (!mentionsHandle(fetchedText, input.config.bot_handle)) {
    return reject("no_mention");
  }
  const stamp = revisionOf(fetched);
  const number = parentNumber(eventName, fetched);
  const reply = stamp && number ? replyFor(eventName, fetched, number) : null;
  if (!stamp || !number || !reply) {
    return reject("missing_object", view.textSource);
  }
  const ledger = {
    event_name: eventName,
    node_id: stamp.node_id,
    updated_at: stamp.updated_at,
  };
  if (duplicate(input.seen, eventName, stamp)) {
    return reject("duplicate");
  }
  const { owner, repo } = splitRepo(fullName);
  const key = threadKey(owner, repo, view.kind, number);
  return {
    accept: true,
    reason: "ok",
    thread_key: key,
    agent_name: agentName(owner, repo, view.kind, number),
    text_source: view.textSource,
    reply_target: reply,
    ledger,
    ledger_path: [eventName, pathSegment(stamp.node_id), pathSegment(stamp.updated_at)],
  };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stdout.write(`${JSON.stringify(reject("invalid_json"))}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(routeEvent(input))}\n`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && entry === fileURLToPath(import.meta.url)) {
  main();
}
