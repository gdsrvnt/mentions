---
name: setup-mentions
description: "Install GitHub mention forwarding into a repository by running scripts/install.sh. Use when asked to set up mentions, install the mention-forward workflow, or route a user's @bot mentions to a webhook."
---

# Set up mentions

This is the only setup entry point. Do not copy the workflow into a repository by hand and do not invent a second installer. From the plugin root (the directory that contains `scripts/` and `skills/`), run `scripts/install.sh`.

## Collect

- `owner/repo` (required), a GitHub repository
- `--user` trigger login (required)
- `--bot` bot handle (required). A leading `@` is optional
- `--secret-prefix` (optional). Default `GROKBOT`, which creates secrets `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY`, and `GROKBOT_WEBHOOK_HEADER`
- `--branch` (optional). Default `mentions/<bot>-forward`
- `--dry-run` when the user wants a preview with no clone, push, or pull request

If a required value is missing, ask for it before running the script. Do not guess the login or the repository.

## Run

```bash
bash scripts/install.sh "<owner/repo>" --user "<login>" --bot "<handle>"
```

Add `--secret-prefix`, `--branch`, or `--dry-run` only when the user supplied them. Use `--dry-run` when they asked to preview.

The script renders `templates/mention-forward.yml`, commits it on a new branch, pushes, opens a pull request, and prints the secrets and webhook routine. Do not merge the pull request or push a branch yourself. For the secrets, send the user the routine's field links plus one secret card per value, then set each repo secret from env (see the webhook header gotcha below); never ask the user to add them by hand. Return the pull request URL.

If the script fails, it deletes any remote branch it pushed and its temporary clone. Do not recreate that branch by hand. Fix the reported cause and run `scripts/install.sh` again.

## After the pull request is merged

The user creates the printed Actions secrets and the webhook routine, then merges. Issue, comment, and discussion workflows run from the default branch. Handle accepted events with the `handle-mention` skill, using the same trigger user, bot handle, and repository.

## Gotcha: webhook header

- The Grok Bot routine panel's "Authorization header" field is the full line, `Authorization: Bearer <key>`, not just a header name.
- The forwarder accepts it pasted verbatim. If the `*_WEBHOOK_HEADER` secret contains `:`, it is sent as the header line and `*_WEBHOOK_KEY` is optional. Otherwise the forwarder sends `<header>: <key>`.
- Symptom of a mismatch: the forward step fails with HTTP 401 `Invalid API key`.
- Debug from the Actions logs with `gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs`. `gh run view --log-failed` can come back empty.
- For setup, prefer secret cards: the bot sets repo secrets from env with `printf %s "$VAR" | gh secret set <NAME> -R <owner>/<repo>`, never by hand and never by echoing values.
