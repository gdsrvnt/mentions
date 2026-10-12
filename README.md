# mentions

Forward GitHub @mentions of a bot to a webhook, then handle each mention as a tracked reply job. A chosen user mentions the bot; GitHub Actions posts `{event_name, payload}` to your webhook; the handler acknowledges, posts milestone progress, and replies with the result it verified.

This repository is a single Cursor plugin. Its manifest is `.cursor-plugin/plugin.json`.

## Install the plugin

Copy or symlink this directory to `~/.cursor/plugins/local/mentions`, then start a new Cursor session so the skills load.

```bash
ln -s "$(pwd)" ~/.cursor/plugins/local/mentions
```

## Components

| Path | Role |
| --- | --- |
| `skills/setup-mentions/SKILL.md` | Setup entry point. Runs `scripts/install.sh`. |
| `skills/handle-mention/SKILL.md` | Handles a forwarded event or a heartbeat. Acks, posts progress, replies, steers the same thread, and runs other threads in parallel. |
| `templates/mention-forward.yml` | Workflow template parameterized by trigger user, bot handle, and secret names. |
| `scripts/install.sh` | Renders the workflow, pushes a branch, opens a pull request, prints the secret and webhook routine, and rolls back on failure. |
| `scripts/test.sh` | Dry-run checks against a local bare repo, plus actionlint on the rendered workflow. |
| `scripts/validate-plugin.mjs` | Manifest and skill-frontmatter validation for this single-plugin repo. |
| `.github/workflows/ci.yml` | Pull-request CI: shellcheck, actionlint, tests, and manifest validation. |

## Set up a repository

Use the `setup-mentions` skill, or from the plugin root:

```bash
scripts/install.sh <owner/repo> --user <login> --bot <handle>
scripts/install.sh <owner/repo> --user <login> --bot <handle> --secret-prefix CUSTOM --branch mentions/setup --dry-run
```

`--dry-run` prints the rendered workflow, pull request body, and secret routine without cloning, pushing, or opening a pull request. A local git path is accepted only with `--dry-run`.

The real install clones the repository, commits `.github/workflows/mention-forward.yml` on a new branch (default `mentions/<bot>-forward`), pushes, and opens a pull request. Commits use the current `git user.name` and `user.email`. On failure, a trap deletes the remote branch if this run pushed it and removes the temporary clone.

You need `git` credentials that can push, and an authenticated `gh` CLI (`gh auth login`) to open the pull request.

## Secrets and webhook

`--secret-prefix` defaults to `GROKBOT`, which selects these Actions secrets:

| Secret | Purpose |
| --- | --- |
| `GROKBOT_WEBHOOK_URL` | HTTPS endpoint of the webhook routine |
| `GROKBOT_WEBHOOK_KEY` | Shared secret sent in the header |
| `GROKBOT_WEBHOOK_HEADER` | Header name that carries the key |

A prefix `CUSTOM` selects `CUSTOM_WEBHOOK_URL`, `CUSTOM_WEBHOOK_KEY`, and `CUSTOM_WEBHOOK_HEADER`.

The webhook routine accepts `POST` JSON:

```json
{"event_name": "issues", "payload": {}}
```

It checks the configured header, then invokes `handle-mention` with that object. Merge the workflow pull request to the default branch before expecting issue, comment, or discussion events to run.

## What the workflow covers

The workflow name is `mention-forward`. The `forward` job runs only when `github.actor` is the trigger user and the event text contains a case-sensitive `@bot` mention. Otherwise the job is skipped.

| Surface | Actions trigger |
| --- | --- |
| Issues opened or edited | `issues` |
| Issue and pull request conversation comments | `issue_comment` |
| Pull requests opened or edited | `pull_request_target` |
| Pull request reviews | `pull_request_review` |
| Inline review comments | `pull_request_review_comment` |
| Discussions | `discussion` |
| Discussion comments | `discussion_comment` |

Pull request opened and edited events use `pull_request_target` so the workflow file and secrets come from the default branch. The job's only step posts the event JSON. It does not check out code and does not run pull request contents. Fork reviews and review comments still use their own event types; GitHub does not provide secrets to those fork events.

`commit_comment` cannot be supported reliably. GitHub Actions has no `commit_comment` trigger, and the events above do not include commit comments.

## Handler

`handle-mention` re-checks the repository, sender, and mention, then drops the event silently when they do not match. It acknowledges on the GitHub surface, launches one herdr agent per thread, steers that agent when the same thread is mentioned again, and lets other threads run in parallel. Heartbeat wakes post new milestone lines and a final reply that contains only effects the handler verified.

The handler needs the `herdr` harness and a webhook routine. It comments and commits as the configured bot identity, not as the trigger user.

## Development

```bash
shellcheck scripts/install.sh scripts/test.sh
actionlint
bash scripts/test.sh
node scripts/validate-plugin.mjs
```

`validate-plugins.mjs` in a cursor-plugins checkout cannot validate this plugin. That script hard-codes its own repository root, requires that checkout's `.cursor-plugin/marketplace.json`, and imports `ajv`. Use `scripts/validate-plugin.mjs` instead. CI runs that local validator.

CI runs those checks on `pull_request` only.

## License

MIT. Copyright (c) 2026 ArchAgents.
