#!/usr/bin/env node
// Decide whether a GitHub webhook event is a mention this install should handle.
// stdin: { event_name, payload, config, seen?, fetched? }
// stdout: { accept, reason, thread_key, agent_name, text_source, reply_target, ledger, ledger_path }
// A final accept requires fetched, the GitHub API object. The delivery name and the thread kind come from that object. A webhook wrap that names a different object is not a delivery.
// A review request (pull_request action review_requested) carries no text. Its fetched object is the pull request's review-request timeline.

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

function nodeIdOf(node) {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (typeof node.node_id === "string" && node.node_id.length > 0) {
    return node.node_id;
  }
  if (typeof node.id === "string" && node.id.length > 0) {
    return node.id;
  }
  return null;
}

function canonicalWrap(eventName) {
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return "pull_request";
  }
  return eventName;
}

function hasPullRequestMarker(fetched) {
  const marker = fetched.pull_request;
  return Boolean(
    marker && typeof marker === "object" && (typeof marker.url === "string" || typeof marker.html_url === "string"),
  );
}

function isDiscussionComment(fetched) {
  const discussion = fetched.discussion;
  if (
    discussion &&
    typeof discussion === "object" &&
    (positiveInt(discussion.number) || nodeIdOf(discussion)) &&
    typeof fetched.body === "string" &&
    typeof fetched.title !== "string"
  ) {
    return true;
  }
  if (typeof fetched.discussion_node_id === "string" && fetched.discussion_node_id.length > 0 && typeof fetched.body === "string") {
    return true;
  }
  return typeof fetched.html_url === "string" && /#discussioncomment-/.test(fetched.html_url);
}

function isReviewComment(fetched) {
  if (typeof fetched.pull_request_url !== "string") {
    return false;
  }
  if (typeof fetched.path === "string" || typeof fetched.diff_hunk === "string" || positiveInt(fetched.pull_request_review_id)) {
    return true;
  }
  return typeof fetched.html_url === "string" && /#discussion_r\d+/.test(fetched.html_url);
}

function isReview(fetched) {
  if (typeof fetched.pull_request_url !== "string" || isReviewComment(fetched)) {
    return false;
  }
  if (typeof fetched.submitted_at === "string") {
    return true;
  }
  if (typeof fetched.html_url === "string" && /#pullrequestreview-\d+/.test(fetched.html_url)) {
    return true;
  }
  return typeof fetched.state === "string" && /^(APPROVED|CHANGES_REQUESTED|COMMENTED|DISMISSED|PENDING)$/.test(fetched.state);
}

function isIssueComment(fetched) {
  return (
    typeof fetched.issue_url === "string" &&
    typeof fetched.html_url === "string" &&
    /#issuecomment-\d+/.test(fetched.html_url)
  );
}

function isDiscussion(fetched) {
  if (typeof fetched.html_url === "string" && /\/discussions\/\d+$/.test(fetched.html_url)) {
    return true;
  }
  const repo = fetched.repository;
  return Boolean(
    repo &&
      typeof repo.owner?.login === "string" &&
      typeof repo.name === "string" &&
      typeof fetched.title === "string" &&
      positiveInt(fetched.number) &&
      !fetched.pull_request &&
      !fetched.issue_url,
  );
}

function isPullRequest(fetched) {
  if (hasPullRequestMarker(fetched)) {
    return true;
  }
  if (fetched.head && typeof fetched.head === "object" && fetched.base && typeof fetched.base === "object" && typeof fetched.title === "string") {
    return true;
  }
  if (typeof fetched.url === "string" && /\/pulls\/\d+(?:$|[?#])/.test(fetched.url) && typeof fetched.title === "string") {
    return true;
  }
  return typeof fetched.html_url === "string" && /\/pull\/\d+$/.test(fetched.html_url) && typeof fetched.title === "string";
}

function isIssue(fetched) {
  if (isPullRequest(fetched)) {
    return false;
  }
  if (typeof fetched.html_url === "string" && /\/issues\/\d+$/.test(fetched.html_url) && typeof fetched.title === "string") {
    return true;
  }
  return typeof fetched.url === "string" && /\/issues\/\d+(?:$|[?#])/.test(fetched.url) && typeof fetched.title === "string";
}

function deliveryOf(fetched) {
  if (!fetched || typeof fetched !== "object") {
    return null;
  }
  if (isDiscussionComment(fetched)) {
    return { event: "discussion_comment", kind: "discussion" };
  }
  if (isReviewComment(fetched)) {
    return { event: "pull_request_review_comment", kind: "pr" };
  }
  if (isReview(fetched)) {
    return { event: "pull_request_review", kind: "pr" };
  }
  if (isIssueComment(fetched)) {
    const kind = kindFromHtml(fetched.html_url);
    if (kind !== "pr" && kind !== "issue") {
      return null;
    }
    return { event: "issue_comment", kind };
  }
  if (isDiscussion(fetched)) {
    return { event: "discussion", kind: "discussion" };
  }
  if (isPullRequest(fetched)) {
    return { event: "pull_request", kind: "pr" };
  }
  if (isIssue(fetched)) {
    return { event: "issues", kind: "issue" };
  }
  return null;
}

function revisionOf(node) {
  const nodeId = nodeIdOf(node);
  if (!nodeId) {
    return null;
  }
  const updated =
    typeof node.updated_at === "string" && node.updated_at.length > 0
      ? node.updated_at
      : typeof node.updatedAt === "string" && node.updatedAt.length > 0
        ? node.updatedAt
        : null;
  if (updated) {
    return { node_id: nodeId, updated_at: updated };
  }
  if (typeof node.submitted_at === "string" && node.submitted_at.length > 0) {
    const body = typeof node.body === "string" ? node.body : "";
    const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
    return { node_id: nodeId, updated_at: `${node.submitted_at}#${digest}` };
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

function kindFromHtml(url) {
  if (typeof url !== "string") {
    return null;
  }
  if (/\/pull\/\d+/.test(url)) {
    return "pr";
  }
  if (/\/issues\/\d+/.test(url)) {
    return "issue";
  }
  if (/\/discussions\/\d+/.test(url)) {
    return "discussion";
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
  if (eventName === "discussion_comment") {
    if (positiveInt(fetched.discussion?.number)) {
      return fetched.discussion.number;
    }
    return positiveInt(fetched.number) ? fetched.number : null;
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
    const discussionId = nodeIdOf(fetched);
    if (!discussionId) {
      return null;
    }
    return { kind: "discussion-comment", discussion_id: discussionId, reply_to_id: null };
  }
  if (eventName === "discussion_comment") {
    const discussionId =
      nodeIdOf(fetched.discussion) || (typeof fetched.discussion_node_id === "string" ? fetched.discussion_node_id : null);
    const commentId = nodeIdOf(fetched);
    if (!discussionId || !commentId) {
      return null;
    }
    return { kind: "discussion-comment", discussion_id: discussionId, reply_to_id: commentId };
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

function fetchedRepo(eventName, fetched) {
  const nested = fetched.discussion?.repository ?? fetched.repository;
  if (typeof nested?.owner?.login === "string" && typeof nested?.name === "string") {
    return `${nested.owner.login}/${nested.name}`;
  }
  return repoFromUrl(parentUrl(eventName, fetched));
}

function isReviewRequest(eventName, payload) {
  return canonicalWrap(eventName) === "pull_request" && payload.action === "review_requested";
}

// GitHub lists timeline items oldest first, so the last match is the newest request.
function newestRequest(events, botHandle, triggerUser) {
  const forBot = events.filter(
    (event) =>
      event &&
      event.__typename === "ReviewRequestedEvent" &&
      lower(event.requestedReviewer?.login) === lower(botHandle),
  );
  if (forBot.length === 0) {
    return { reason: "no_review_request" };
  }
  const byTrigger = forBot.filter((event) => lower(event.actor?.login) === lower(triggerUser));
  if (byTrigger.length === 0) {
    return { reason: "wrong_sender" };
  }
  return { event: byTrigger[byTrigger.length - 1] };
}

function routeReviewRequest(input, payload, fullName) {
  const { trigger_user: triggerUser, bot_handle: botHandle } = input.config;
  if (lower(payload.requested_reviewer?.login) !== lower(botHandle)) {
    return reject("no_review_request");
  }
  const pull = payload.pull_request;
  if (!positiveInt(pull?.number)) {
    return reject("missing_object");
  }
  const textSource = graphql(fullName, pull.number, "review_requested", pull.node_id ?? null);
  if (!input.fetched) {
    return reject("needs_fetch", textSource);
  }
  const fetched = input.fetched;
  if (!fetched || typeof fetched !== "object" || Array.isArray(fetched)) {
    return reject("missing_object", textSource);
  }
  const linkedRepo = fetchedRepo("pull_request", fetched);
  if (!linkedRepo || lower(linkedRepo) !== lower(fullName)) {
    return reject("wrong_repo");
  }
  const events = fetched.timelineItems?.nodes;
  if (!positiveInt(fetched.number) || !Array.isArray(events)) {
    return reject("missing_object", textSource);
  }
  const found = newestRequest(events, botHandle, triggerUser);
  if (!found.event) {
    return reject(found.reason);
  }
  const stamp = {
    node_id: nodeIdOf(found.event),
    updated_at: typeof found.event.createdAt === "string" ? found.event.createdAt : null,
  };
  if (!stamp.node_id || !stamp.updated_at) {
    return reject("missing_object", textSource);
  }
  if (duplicate(input.seen, stamp)) {
    return reject("duplicate");
  }
  const { owner, repo } = splitRepo(fullName);
  const number = fetched.number;
  return {
    accept: true,
    reason: "ok",
    thread_key: threadKey(owner, repo, "pr", number),
    agent_name: agentName(owner, repo, "pr", number),
    text_source: textSource,
    reply_target: { kind: "issue-comment", number },
    ledger: { event_name: "review_requested", ...stamp },
    ledger_path: ["review_requested", pathSegment(stamp.node_id), pathSegment(stamp.updated_at)],
  };
}

function duplicate(seen, identity) {
  if (!Array.isArray(seen) || !identity) {
    return false;
  }
  return seen.some((row) => row && row.node_id === identity.node_id && row.updated_at === identity.updated_at);
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
  if (isReviewRequest(eventName, payload)) {
    return routeReviewRequest(input, payload, fullName);
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
  const delivery = deliveryOf(fetched);
  const linkedRepo = fetchedRepo(delivery ? delivery.event : eventName, fetched);
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
  if (!delivery || canonicalWrap(eventName) !== delivery.event) {
    return reject("missing_object", view.textSource);
  }
  const stamp = revisionOf(fetched);
  const number = parentNumber(delivery.event, fetched);
  const kind = delivery.kind;
  const reply = stamp && number ? replyFor(delivery.event, fetched, number) : null;
  if (!stamp || !number || !reply) {
    return reject("missing_object", view.textSource);
  }
  const ledger = {
    event_name: delivery.event,
    node_id: stamp.node_id,
    updated_at: stamp.updated_at,
  };
  if (duplicate(input.seen, stamp)) {
    return reject("duplicate");
  }
  const { owner, repo } = splitRepo(fullName);
  const key = threadKey(owner, repo, kind, number);
  return {
    accept: true,
    reason: "ok",
    thread_key: key,
    agent_name: agentName(owner, repo, kind, number),
    text_source: view.textSource,
    reply_target: reply,
    ledger,
    ledger_path: [delivery.event, pathSegment(stamp.node_id), pathSegment(stamp.updated_at)],
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
