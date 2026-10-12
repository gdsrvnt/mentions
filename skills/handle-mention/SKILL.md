---
name: handle-mention
description: "Handle a forwarded GitHub mention payload (event_name and payload) or a heartbeat for a running mention job. Acknowledge on GitHub, post milestone progress, and reply with the verified result. Steer the same thread; run other threads in parallel."
---

# Handle a mention

When a webhook routine delivers `{event_name, payload}`, or a herdr heartbeat wakes you for a running mention job, handle it as a prompt from the trigger user. Reply only with GitHub comments from the bot identity. Do not answer in chat.

## Configuration

Use the same trigger user, bot handle, and repository passed to `scripts/install.sh`.

```yaml
trigger_user: <github-login>
bot_handle: <handle-without-at>
repo: <owner/name>
comment_as: <bot-github-login>
gh_token_env: <ENV_VAR_HOLDING_THE_BOT_PAT>
commit_name: <git author name>
commit_email: <git author email>
state_dir: <absolute-directory-for-jobs-and-context>
work_root: <parent-directory-for-repo-workspaces>
```

Before every `gh` or `git` call, export `GH_TOKEN` from the environment variable named by `gh_token_env`. Author commits as `commit_name <commit_email>`. Never authenticate as `trigger_user`.

State lives in `state_dir`:

- `state_dir/jobs.json` maps a thread key to `{tab, agent, pane, surface, reply_target, status, started, last_progress}`. `last_progress` is the number of milestone lines already posted. `reply_target` is `{kind, number, comment_id, discussion_id, reply_to_id}` for the ack API below.
- `state_dir/ctx/<thread>/` holds `prompt.md`, `progress.md`, `result.md`, and fetched context

`herdr` is the harness. Resolve the heartbeat helper from `HERDR_HEARTBEAT` when that variable is set, otherwise from `herdr-heartbeat.sh` on `PATH`.

## A. New event

1. **Parse.** Input is `{event_name, payload}`. Take the text from the event:

   | event_name | text |
   | --- | --- |
   | `issues` | issue title + body |
   | `issue_comment` | comment body |
   | `pull_request` or `pull_request_target` | pull request title + body |
   | `pull_request_review` | review body |
   | `pull_request_review_comment` | comment body |
   | `discussion` | discussion title + body |
   | `discussion_comment` | comment body |

   Any other `event_name` is dropped. `commit_comment` is not produced by the workflow; GitHub Actions has no reliable `commit_comment` trigger. If such a payload is ever delivered anyway, the reply API is `gh api repos/<repo>/commits/<sha>/comments -f body=...`.

2. **Re-verify, and drop silently on any failure.** Require `payload.repository.full_name == repo`, `payload.sender.login == trigger_user` exactly, and a case-sensitive `@bot_handle` in the text. Confirm with the live API that the comment or item still exists and that its author is still `trigger_user`. Do not comment when a check fails.

3. **Thread key.** Build `<owner>-<repo>-<kind>-<n>` from `repo`. Lowercase it and replace every character outside `[a-z0-9_-]` with `-`. The jobs.json key is this full thread key, so the same GitHub thread always steers the same job. The herdr agent name is that key truncated to 32 characters from the end and still matches `[a-z0-9_-]`.
   - `issues`: kind `issue`, `n` is `issue.number`
   - `issue_comment`: if `issue.pull_request` is present, kind `pr` and `n` is `issue.number`; otherwise kind `issue` and `n` is `issue.number`
   - `pull_request`, `pull_request_target`, `pull_request_review`, and `pull_request_review_comment`: kind `pr`, `n` is `pull_request.number`
   - `discussion` and `discussion_comment`: kind `discussion`, `n` is `discussion.number`

4. **Fetch context into `state_dir/ctx/<thread>/`.**
   - Issue: `gh issue view N --repo <repo> --json title,body,author,comments,labels,state`
   - Pull request: `gh pr view N --repo <repo> --json title,body,author,comments,reviews,files,headRefName,baseRefName,state`, `gh pr diff N --repo <repo>`, and `gh api repos/<repo>/pulls/N/comments --paginate`
   - Discussion: GraphQL `repository{discussion(number:N){id title body author{login} comments(first:100){nodes{id body author{login} replies(first:50){nodes{id body author{login}}}}}}}`
   - Write `prompt.md` containing the triggering text verbatim, marked as `trigger_user`'s prompt, plus the context paths.

5. **Ack immediately**, then save `reply_target`. Progress comments and the final reply use this same target.
   - Issue or pull request conversation, pull request body, or review: `{kind: issue-comment, number: N}`. Post with `gh api repos/<repo>/issues/N/comments -f body=...`
   - Inline review comment: `{kind: review-comment-reply, number: N, comment_id}`. Post with `gh api repos/<repo>/pulls/N/comments/<comment_id>/replies -f body=...`
   - Discussion or discussion comment: `{kind: discussion-comment, discussion_id, reply_to_id?}`. Post with GraphQL `addDiscussionComment(input:{discussionId, body, replyToId?})`. `replyToId` is the top-level comment id; for a reply, use its parent.
   - A new job's ack is a short "On it" note and a one-line plan. A steer ack says it is steering the running job.

6. **Same thread steers; other threads run in parallel.**
   - If `jobs.json[thread].status == running` and that herdr agent still exists (`herdr pane list`), steer it: `herdr agent prompt <agent> "New instruction from <trigger_user> on GitHub: <text>. Context: <state_dir>/ctx/<thread>/"`, then read `--source visible` to confirm it took. Do not open another tab for that thread.
   - Otherwise launch a separate tab and agent so other thread keys keep running in parallel. Workspace is `<work_root>/<repo-name>` (create it if it does not exist). `herdr tab create`, then start the agent under the thread's agent name. Prompt it with `prompt.md`, the identity rule, authority to carry out the request as `comment_as` (including commits, pull requests, and merges when the request asks), and "append milestones to `<state_dir>/ctx/<thread>/progress.md` and write the final answer to `<state_dir>/ctx/<thread>/result.md`". Confirm it took (trust dialog, `pane run` fallback). Record the job with `status: running`.
   - Start the heartbeat in the background:

     ```bash
     herdr-heartbeat.sh --agents <agent> \
       --expect <state_dir>/ctx/<thread>/result.md \
       --expect <state_dir>/ctx/<thread>/progress.md
     ```

     Then end the turn. Never wait in-session.

## B. Heartbeat wake

For each running job in `jobs.json` (other threads may be running in parallel):

- `progress.md` has more non-empty lines than `last_progress`: post only the new lines to `reply_target` and set `last_progress` to the new line count.
- `result.md` exists and the agent is idle or done: verify the claimed effects yourself (diff, pull request, merge state). Post the final reply with only what you verified, set `status: done`, and close only the tab this job created.
- Exit 11 (blocked): do not answer the agent's dialog. Post a progress comment naming the blocker and leave the job running.
- Exit 13 or 14 (stall or cap): read the screen and nudge once if it is clearly stuck. Otherwise post a progress note.
- Relaunch the heartbeat in the background while any job is still `running`, then end the turn.

## Rules

- Drop non-matching events silently, with no comment.
- Do not fabricate. A final reply states only what you verified.
- Never check out or run pull request code from an untrusted fork outside the herdr agent's sandboxed task.
- Do not close tabs or agents that belong to another thread.
