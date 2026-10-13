# Install the workflow

A user installs mention forwarding into their repository. `scripts/install.sh <owner/repo> --user <login> --bot <handle>` clones the repo, commits `.github/workflows/mention-forward.yml` on a new branch, pushes it, opens a pull request, and prints the secrets and webhook routine to create. If anything fails after the push, the script deletes that branch and its temp clone. The `setup-mentions` skill then sets the three Actions secrets from environment variables, by name, without echoing their values.

## Sub-features

- `install-pr` pushes branch `mentions/<bot>-forward` containing only the rendered workflow, then opens a PR against the default branch with the generated body.
- `install-report` prints the plan, `base:`, `pull_request:`, and the `===== SECRETS AND WEBHOOK =====` block.
- `install-rollback` makes a failure after the push (for example, PR creation) delete the remote branch and the temp clone and exit non-zero.
- `install-refuse-existing` refuses an existing remote branch, or a repo that already has the workflow, before pushing anything.
- `install-secrets` covers the skill's secret step: `printf %s "$VAR" | gh secret set <NAME> -R <owner/repo>` sets each secret, and no value appears in output or logs.

## How to get to it (user POV)

- Terminal: `scripts/install.sh <owner/repo> --user <login> --bot <handle> [--secret-prefix X] [--branch B]` (README "Set up a repository").
- Agent: ask the `setup-mentions` skill to set up mentions. It runs `bash scripts/install.sh "<owner/repo>" --user "<login>" --bot "<handle>"`, returns the PR URL, and then sets secrets from env with `gh secret set`.

## Driving it with control-mentions

Preconditions:

- `control-mentions doctor --run "$id"` ends with `doctor: OK`.
- `control-mentions origin --run "$id" octo-org/sandbox` has created the sandbox origin, and `control-mentions refs --run "$id" octo-org/sandbox` shows only `refs/heads/main`.

- **Rollback first, on a clean origin.** Make PR creation fail. Run `control-mentions drive --run "$id" --label install-rollback --env FAKE_GH_FAIL="pr create" -- scripts/install.sh octo-org/sandbox --user octo-user --bot helper-bot`. Exit is `1`. Stderr has `fake gh refusing: pr create`, `rollback: deleting remote branch mentions/helper-bot-forward`, and `rollback: removing temp clone`. The summary shows `git calls: … push×2` (the push and its delete), `origin refs changed: none`, and `tmp leftovers: none`.
- **Install (terminal entry).** Run `control-mentions drive --run "$id" --label install-pr -- scripts/install.sh octo-org/sandbox --user octo-user --bot helper-bot`. Exit is `0`. Stdout has `mode: install`, `base: main`, `pull_request: https://github.invalid/octo-org/sandbox/pull/1`, and the secrets block. The summary shows `gh calls: 3 → auth status; repo clone; pr create` and `origin refs changed: > octo-org/sandbox.git refs/heads/mentions/helper-bot-forward <sha>`.
- **Second view of the push.** Read the branch from the origin. Run `control-mentions drive --run "$id" --label install-pr-check -- bash -c 'o="$VM_ORIGIN/octo-org/sandbox.git"; git -C "$o" log -1 --format="%an <%ae>%n%s" mentions/helper-bot-forward && git -C "$o" diff --stat main mentions/helper-bot-forward && git -C "$o" show mentions/helper-bot-forward:.github/workflows/mention-forward.yml | grep -n -e "github.actor == .octo-user." -e "@helper-bot" -e "secrets.GROKBOT_WEBHOOK_URL"'`. The output shows author `Sandbox Verifier <sandbox-verifier@example.invalid>`, subject `Add mention-forward workflow for @helper-bot`, exactly one file changed (`.github/workflows/mention-forward.yml`), and the three grep hits.
- **PR body.** Read `steps/*-install-pr/pr-1-body.md` and `gh-calls.txt`. The body starts with `## Summary`, names `@helper-bot` and `octo-user`, and contains `## Secrets and webhook`. The `pr create` call shows `--base main --head mentions/helper-bot-forward --title Forward\ @helper-bot\ mentions\ from\ octo-user`.
- **Refuse an existing branch.** Run the install again. Run `control-mentions drive --run "$id" --label install-refuse-existing -- scripts/install.sh octo-org/sandbox --user octo-user --bot helper-bot`. Exit is `1` with `error: remote branch already exists: mentions/helper-bot-forward`. The summary shows no `push` and no `pr create`, and `origin refs changed: none`.
- **Secrets by name (agent entry, secret step).** Run the skill's command with synthetic values from env. Run `control-mentions drive --run "$id" --label install-secrets --env WEBHOOK_URL_VALUE=https://example.invalid/hook --env WEBHOOK_HEADER_VALUE="Authorization: Bearer test-key-123" -- bash -c 'printf %s "$WEBHOOK_URL_VALUE" | gh secret set GROKBOT_WEBHOOK_URL -R octo-org/sandbox && printf %s "$WEBHOOK_HEADER_VALUE" | gh secret set GROKBOT_WEBHOOK_HEADER -R octo-org/sandbox'`. Exit is `0`. `secrets.txt` has two lines with name, repo, byte count, and sha256 prefix. `grep -r test-key-123 "$(control-mentions evidence --run "$id")/steps/"*-install-secrets/` matches only `cmd.txt`, never `stdout.txt`, `stderr.txt`, `gh-calls.txt`, or `secrets.txt`.
- **Proof.** Keep the `install-pr` step, the `install-pr-check` output, and `pr-1-body.md`, plus the `install-rollback` step with `refs-changed.txt` = `none`.

## Gotchas

- Run rollback before the successful install, or launch a new run first. Once `mentions/helper-bot-forward` exists, every later install refuses before pushing, so rollback never gets exercised.
- `--env` values are recorded in `cmd.txt`. Use only synthetic secrets in drives.
- The fake `gh` cannot tell which account it is, so it cannot prove that the PR opens as the right identity. Real auth is a stand-in limit.
- install.sh checks `git config user.name`/`user.email`, but git takes the author from `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars when they are set. Some hosts export them (one exported the bot's identity during the first proof run). Drives strip them, so the sandbox author `Sandbox Verifier` proves isolation. Any other author means the env leaked: stop and fix the harness.
- `gh repo clone` runs with `-- --quiet`, so the fake passes `--quiet` through to `git clone`. Clone errors show on stderr as git's own messages.
