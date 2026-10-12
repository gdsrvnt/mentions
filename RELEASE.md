# Release 1.0.0

Release date: 2026-10-12

## Summary

mentions 1.0.0 forwards a chosen GitHub user's @mentions of a bot to a webhook and handles each mention as a tracked reply job.

## What's included

- `templates/mention-forward.yml` is parameterized by the trigger user, the bot handle, and the webhook secret names. The defaults are `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY`, and `GROKBOT_WEBHOOK_HEADER`. The workflow POSTs `{"event_name", "payload"}`.
- Covered surfaces are issues, issue comments, pull requests, pull request reviews, inline review comments, discussions, and discussion comments. Pull request opened and edited events use `pull_request_target`. The job does not check out repository code.
- `commit_comment` is not supported. GitHub Actions has no reliable trigger for commit comments.
- The `setup-mentions` skill runs `scripts/install.sh`. The script opens a pull request and prints the secrets and webhook routine. `--dry-run` performs no network writes. If install fails, the script deletes the remote branch it pushed and its temporary clone.
- The `handle-mention` skill acknowledges the mention, posts milestone progress, and replies with the verified result. A mention on a thread that is already running steers that job. Other threads run in parallel.
- Pull-request CI runs shellcheck, actionlint, `scripts/test.sh`, and `scripts/validate-plugin.mjs`.

## Install

Load this directory as a local Cursor plugin (`~/.cursor/plugins/local/mentions`), then from the plugin root:

```bash
scripts/install.sh <owner/repo> --user <login> --bot <handle>
```

Create the printed Actions secrets and webhook routine, and merge the workflow pull request to the default branch.

## License

MIT.
