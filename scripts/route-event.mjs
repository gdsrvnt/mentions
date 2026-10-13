#!/usr/bin/env node
// Decide whether a GitHub webhook event is a mention this install should handle.
// stdin: { event_name, payload, config, seen? }
// stdout: { accept, reason, thread_key, agent_name, text_source, reply_target, ledger }

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

function reject(reason) {
  return {
    accept: false,
    reason,
    thread_key: null,
    agent_name: null,
    text_source: null,
    reply_target: null,
    ledger: null,
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

function threadKey(fullName, kind, number) {
  return `${fullName}-${kind}-${number}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function agentName(key, kind, number) {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 8);
  const name = `${hash}-${kind}-${number}`;
  return name.length <= 32 ? name : hash;
}

function rest(fullName, path) {
  return { api: "rest", method: "GET", path: `/repos/${fullName}${path}` };
}

function graphql(fullName, number, what, nodeId) {
  const slash = fullName.indexOf("/");
  return {
    api: "graphql",
    owner: fullName.slice(0, slash),
    name: fullName.slice(slash + 1),
    number,
    what,
    node_id: nodeId ?? null,
  };
}

function stamp(node) {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (typeof node.node_id !== "string" || typeof node.updated_at !== "string") {
    return null;
  }
  return { node_id: node.node_id, updated_at: node.updated_at };
}

function isForkPullRequest(payload) {
  return payload?.pull_request?.head?.repo?.fork === true;
}

function viewFor(eventName, payload) {
  const fullName = payload?.repository?.full_name;
  if (eventName === "issues") {
    const issue = payload.issue;
    return {
      text: textOf(issue?.title, issue?.body),
      kind: "issue",
      number: issue?.number,
      stamp: stamp(issue),
      textSource: positiveInt(issue?.number) ? rest(fullName, `/issues/${issue.number}`) : null,
      reply: positiveInt(issue?.number) ? { kind: "issue-comment", number: issue.number } : null,
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
      stamp: stamp(comment),
      textSource: positiveInt(comment?.id) ? rest(fullName, `/issues/comments/${comment.id}`) : null,
      reply: positiveInt(issue?.number) ? { kind: "issue-comment", number: issue.number } : null,
      fork: false,
    };
  }
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const pull = payload.pull_request;
    return {
      text: textOf(pull?.title, pull?.body),
      kind: "pr",
      number: pull?.number,
      stamp: stamp(pull),
      textSource: positiveInt(pull?.number) ? rest(fullName, `/pulls/${pull.number}`) : null,
      reply: positiveInt(pull?.number) ? { kind: "issue-comment", number: pull.number } : null,
      fork: isForkPullRequest(payload),
    };
  }
  if (eventName === "pull_request_review") {
    const pull = payload.pull_request;
    const review = payload.review;
    return {
      text: textOf(review?.body),
      kind: "pr",
      number: pull?.number,
      stamp: stamp(review),
      textSource:
        positiveInt(pull?.number) && positiveInt(review?.id)
          ? rest(fullName, `/pulls/${pull.number}/reviews/${review.id}`)
          : null,
      reply: positiveInt(pull?.number) ? { kind: "issue-comment", number: pull.number } : null,
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
      stamp: stamp(comment),
      textSource: positiveInt(comment?.id) ? rest(fullName, `/pulls/comments/${comment.id}`) : null,
      reply:
        positiveInt(pull?.number) && positiveInt(comment?.id)
          ? { kind: "review-comment-reply", number: pull.number, comment_id: comment.id }
          : null,
      fork: isForkPullRequest(payload),
    };
  }
  if (eventName === "discussion") {
    const discussion = payload.discussion;
    return {
      text: textOf(discussion?.title, discussion?.body),
      kind: "discussion",
      number: discussion?.number,
      stamp: stamp(discussion),
      textSource: positiveInt(discussion?.number)
        ? graphql(fullName, discussion.number, "discussion", discussion.node_id ?? null)
        : null,
      reply: discussion?.node_id
        ? { kind: "discussion-comment", discussion_id: discussion.node_id, reply_to_id: null }
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
      stamp: stamp(comment),
      textSource: positiveInt(discussion?.number)
        ? graphql(fullName, discussion.number, "discussion_comment", comment?.node_id ?? null)
        : null,
      reply: discussion?.node_id
        ? {
            kind: "discussion-comment",
            discussion_id: discussion.node_id,
            reply_to_id: comment?.parent_node_id || comment?.node_id || null,
          }
        : null,
      fork: false,
    };
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
  if (!positiveInt(view.number) || !view.textSource || !view.reply || !view.stamp) {
    return reject("missing_object");
  }
  const ledger = {
    event_name: eventName,
    node_id: view.stamp.node_id,
    updated_at: view.stamp.updated_at,
  };
  if (duplicate(input.seen, eventName, view.stamp)) {
    return reject("duplicate");
  }
  const key = threadKey(fullName, view.kind, view.number);
  return {
    accept: true,
    reason: "ok",
    thread_key: key,
    agent_name: agentName(key, view.kind, view.number),
    text_source: view.textSource,
    reply_target: view.reply,
    ledger,
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
