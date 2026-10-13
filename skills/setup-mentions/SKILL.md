---
name: setup-mentions
description: "Install GitHub mention forwarding for a Grok Bot webhook routine. Run scripts/install.sh, set the Actions secrets, and paste templates/routine-prompt.md into the routine."
---

# Set up mentions

Inputs. `owner/repo`, the trigger login, and the bot handle. Optional flags are listed below.

Outputs. A pull request URL, or a dry-run plan when the user asked to preview.

Side effects. A real run pushes one branch, opens one pull request, and merges the repository into the handler config. Dry-run does none of those. This skill does not merge the pull request unless the user asks.

This is the only setup entry point. Do not copy the workflow in by hand and do not invent a second installer. Run the script from the plugin root, the directory that contains `scripts/` and `skills/`.

## Collect

Ask before running when a required value is missing. Do not guess the login or the repository.

- `--user` trigger login
- `--bot` mention handle, with or without a leading `@`
- `--comment-as` account that comments and commits. Default is the bot handle
- `--secret-prefix` secret name prefix. Default `MENTION`
- `--branch` branch name. Default `mentions/<bot>-forward`
- `--config` handler config path
- `--commit-name` git name the bot uses for commits
- `--commit-email` git email the bot uses for commits
- `--comments-only` leave the commit identity empty so the agent does not commit
- `--update` replace an existing workflow file
- `--dry-run` print the plan only

A real install needs `--commit-name` and `--commit-email`, or `--comments-only`. The installer also requires `git user.name` and `git user.email` on the machine that runs it. Those commit the workflow. They are not copied into the handler config.

## Run

Preview first when the user has not already seen the plan.

```bash
bash scripts/install.sh "<owner/repo>" --user "<login>" --bot "<handle>" --dry-run
```

Then run the same command without `--dry-run`, and pass `--commit-name` and `--commit-email`, or `--comments-only`. Add `--secret-prefix`, `--branch`, `--comment-as`, `--config`, or `--update` only when the user supplied them.

The script renders `templates/mention-forward.yml`, commits `.github/workflows/mention-forward.yml`, pushes, opens a pull request, and writes the handler config. Before the push it checks that the active `gh` credential can push. That setup credential needs Contents write, Pull requests write, Workflows write, and Secrets write on the selected repositories. The push check does not prove those fine-grained scopes. The runtime bot token does not get Workflows or Secrets write.

If pull request creation fails, or the script is interrupted after the push, it asks GitHub whether any pull request for that head exists, including a closed one. It deletes the branch only when that query succeeds and no pull request is there. If the query fails, or a pull request exists, it keeps the branch and prints it. Do not delete that branch by hand. Fix the reported cause and run `scripts/install.sh` again.

## Secrets

The default secret names are `MENTION_WEBHOOK_URL`, `MENTION_WEBHOOK_HEADER`, and `MENTION_WEBHOOK_KEY`. A prefix `ACME` uses `ACME_WEBHOOK_URL`, `ACME_WEBHOOK_HEADER`, and `ACME_WEBHOOK_KEY`.

`MENTION_WEBHOOK_HEADER` is the full Authorization line from the Grok Bot routine panel. Leave `MENTION_WEBHOOK_KEY` unset in that case. Set the key only when the header secret is a bare header name.

Inside Grok Bot, set each secret from the environment with a secret card. The bot reads `WEBHOOK_URL`, `WEBHOOK_HEADER`, and, only for a bare header name, `WEBHOOK_KEY`.

```bash
printf '%s' "$WEBHOOK_URL" | gh secret set MENTION_WEBHOOK_URL -R "<owner/repo>"
printf '%s' "$WEBHOOK_HEADER" | gh secret set MENTION_WEBHOOK_HEADER -R "<owner/repo>"
```

Do not echo the values. Do not ask the user to paste them into the GitHub UI. A person who is not inside Grok Bot runs the same `gh secret set` commands.

## Routine

Create a Grok Bot routine with a webhook trigger. Copy the webhook URL into the URL secret and the full Authorization line into the header secret. Paste `templates/routine-prompt.md` as the routine prompt. Do not rewrite it.

## Merge and smoke test

Merge the workflow pull request when the user asks. Events run only from the default branch.

After the merge, the smoke test has three cases.

1. The trigger user mentions the bot. The workflow runs and the routine receives the event.
2. The bot mentions itself. The job is skipped.
3. The trigger user comments without the mention. The job is skipped.

Read the run with `gh run view`. When `gh run view --log-failed` is empty, read the job log with `gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs`. A 401 that says the API key is invalid means the header secret was split. Put the full Authorization line in the header secret.

## Flags

- `--user`
- `--bot`
- `--comment-as`
- `--secret-prefix`
- `--branch`
- `--config`
- `--commit-name`
- `--commit-email`
- `--comments-only`
- `--update`
- `--dry-run`
