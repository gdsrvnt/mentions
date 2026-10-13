# Handle a mention

An agent behind the webhook routine receives `{event_name, payload}` and runs the `handle-mention` skill. It calls `scripts/route-event.mjs` twice. The first result is `needs_fetch` plus `text_source`. The agent fetches that GitHub object and calls the router again with `fetched`. The second result supplies `thread_key`, `agent_name`, `reply_target`, `ledger`, and `ledger_path`. Webhook numbers, node ids, and the issue-versus-PR flag are not the thread.

It claims the thread with `scripts/thread-state.mjs` before it posts or launches. A `busy` claim has already stored that request for retry. A `duplicate` claim stops. `launch` and `steer` come from the claim. Steer only when `agent_alive` is true because `herdr` still shows that agent. The reply agent posts progress and the final reply with `-F body=@file`. This skill does not post those, and it does not run a heartbeat.

Live handler behavior is not verified until a drive exercises this path. The steps below are the contract. They are not a record of a run.

## Sub-features

- `handle-drop`: a sender other than `trigger_user`, another repo, or text without a real `@bot_handle` boundary gets no comment, no claim, and no herdr call. Matching ignores case. `@bot` does not match `@bot2`.
- `handle-ack`: a matching `issue_comment` fetches the comment, claims the thread, and posts an ack with `-F body=@file` to the reply target from the second router result. The claim writes `prompt_path`. There is no `jobs.json` and no unsanitized `octo-org-sandbox-pr-7` agent name.
- `handle-launch`: a new thread creates a herdr tab and starts the agent named by `agent_name`, with `prompt_path` as the instruction file. Then `thread-state.mjs commit` records the ledger. No heartbeat script starts.
- `handle-steer`: a later mention on a thread whose agent is alive claims with `agent_alive: true`, gets `steer`, and runs `herdr agent prompt`. It creates no new tab. A vanished agent is a launch, not a steer.
- `handle-parallel`: a mention on another thread gets its own `work_dir`, which includes the owner, the repo, and the thread key. The first thread's checkout stays untouched.
- `handle-busy`: a second distinct comment that arrives during a claim is stored at `request_path` and retried. It is not discarded.
- `handle-final`: the reply agent posts the final comment itself. The dispatcher does not post it on a heartbeat wake.

## How to get to it (user POV)

- The trigger user comments `@helper-bot …` on GitHub. The workflow forwards the event, and the Grok Bot webhook routine invokes the agent with the `handle-mention` skill.

## Driving it with control-mentions

Preconditions:

- **External-call consent.** A real drive sends the fixture prompt to the agent's model provider. Run it only when the user has allowed that. Otherwise report every `handle-*` sub-feature as not verified, with reason "needs an online agent run".
- `control-mentions doctor --run "$id"` ends with `doctor: OK`.
- The handler config is JSON with `trigger_user`, `bot_handle`, `repos`, `comment_as`, `gh_token_env`, `state_dir`, `work_root`, `commit_name`, and `commit_email`. It is not a YAML file with a single `repo` key.

Posts use `-F body=@file`. A drive that shows `-f body=` fails this contract.

## Gotchas

- This recipe has not been executed against the current skill. The router and `thread-state.mjs` tests cover the decisions. They do not cover a live herdr session.
- `--online` is required for the model API. GitHub stays on the recording `gh` fake. If a step posts comment text inside a shell quote, fail the run.
- `FAKE_HERDR_AGENTS` is how a drive says which agents are alive. Without it, a repeat mention launches instead of steering.
