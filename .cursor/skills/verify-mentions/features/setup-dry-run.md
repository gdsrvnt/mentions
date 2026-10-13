# Preview setup (dry-run)

A user previews what setup will do for their repository, user, and bot. `scripts/install.sh … --dry-run` prints the plan, the rendered workflow, the pull request body, and the secrets and webhook routine, and touches nothing.

## Sub-features

- `dry-render` renders the trigger user, bot handle, and secret names into the workflow, with no `__MENTIONS_` placeholders left, and the result passes actionlint.
- `dry-prefix` makes `--secret-prefix ACME` rename all three secrets and leaves no `GROKBOT`.
- `dry-branch` makes `--branch` set the branch, and a leading `@` on `--bot` gets stripped.
- `dry-skips` performs no `gh` call, no network git, no origin change, and leaves no temp files, even with the network removed.
- `dry-local-path` accepts a local git path only with `--dry-run`.
- `dry-validation` rejects bad input with a non-zero exit and an `error:` line.
- `dry-help` makes `--help` exit 0 and list every flag.

## How to get to it (user POV)

- Terminal, as the README "Set up a repository" section shows: `scripts/install.sh <owner/repo> --user <login> --bot <handle> [--secret-prefix X] [--branch B] --dry-run`.
- Agent: ask the `setup-mentions` skill to preview setup. It runs `bash scripts/install.sh "<owner/repo>" --user "<login>" --bot "<handle>" --dry-run`.

## Driving it with control-mentions

Preconditions:

- `control-mentions doctor --run "$id"` ends with `doctor: OK`.
- No origin is needed. Dry-run must not clone.

- **Render (terminal entry).** Run `control-mentions drive --run "$id" --label dry-render -- scripts/install.sh octo-org/sandbox --user octo-user --bot helper-bot --dry-run`. Exit is `0`. Stdout has `mode: dry-run`, `trigger_user: octo-user`, `mention: @helper-bot`, `secret_url: GROKBOT_WEBHOOK_URL`, `branch: mentions/helper-bot-forward`, the `===== RENDERED WORKFLOW =====` … `===== END RENDERED WORKFLOW =====` block containing `github.actor == 'octo-user'` and `'@helper-bot'`, and the last line `dry-run: no network writes`.
- **Lint what was rendered.** Save the block and lint it. Run `E=$(control-mentions evidence --run "$id"); awk '/^===== RENDERED WORKFLOW =====$/{f=1;next} /^===== END RENDERED WORKFLOW =====$/{f=0} f' "$E"/steps/*-dry-render/stdout.txt > "$E/mention-forward.yml" && actionlint "$E/mention-forward.yml" && ! grep -n '__MENTIONS_' "$E/mention-forward.yml"`. Exit is `0` with no output.
- **Observe what dry-run skipped.** Read the `dry-render` step summary. It shows `network: none (unshare -rn)`, `gh calls: 0`, `git calls: 1 → check-ref-format×1`, `origin refs changed: none`, and `tmp leftovers: none`.
- **Agent entry.** Run the skill's exact command. Run `control-mentions drive --run "$id" --label dry-skill-entry -- bash scripts/install.sh "octo-org/sandbox" --user "octo-user" --bot "helper-bot" --dry-run`. The stdout matches `dry-render` (`diff` the two `stdout.txt` files shows no difference) and the summary again shows zero `gh` calls.
- **Secret prefix.** Run `control-mentions drive --run "$id" --label dry-prefix -- scripts/install.sh octo-org/sandbox --user octo-user --bot helper-bot --secret-prefix ACME --dry-run`. Stdout has `secret_url: ACME_WEBHOOK_URL`, `secret_key: ACME_WEBHOOK_KEY`, `secret_header: ACME_WEBHOOK_HEADER`, and `secrets.ACME_WEBHOOK_URL`. `grep -c GROKBOT` on its `stdout.txt` prints `0`.
- **Branch and `@`.** Run `control-mentions drive --run "$id" --label dry-branch -- scripts/install.sh octo-org/sandbox --user octo-user --bot @helper-bot --branch feature/mentions --dry-run`. Stdout has `bot_handle: helper-bot` and `branch: feature/mentions`.
- **Local path, dry-run only.** Make an origin and point at its path. Run `control-mentions origin --run "$id" octo-org/local-preview`, then `control-mentions drive --run "$id" --label dry-local-path -- bash -c 'scripts/install.sh "$VM_ORIGIN/octo-org/local-preview.git" --user octo-user --bot helper-bot --dry-run'`. Exit is `0` and the summary shows `git calls: 2 → check-ref-format×1, rev-parse×1`. Then run `control-mentions drive --run "$id" --label dry-local-path-real -- bash -c 'scripts/install.sh "$VM_ORIGIN/octo-org/local-preview.git" --user octo-user --bot helper-bot'`. Exit is `1` with `error: a local git path supports only --dry-run; pass owner/repo to open a pull request`, and `gh calls: 0`.
- **Validation.** Run each of these as its own drive and expect a non-zero exit plus the quoted stderr line:
  - `--label dry-bad-bot -- scripts/install.sh octo-org/sandbox --user octo-user --bot my_bot --dry-run` gives `error: invalid --bot handle: my_bot`.
  - `--label dry-bad-prefix -- scripts/install.sh octo-org/sandbox --user octo-user --bot helper-bot --secret-prefix lower --dry-run` gives `error: invalid --secret-prefix: lower …`.
  - `--label dry-no-user -- scripts/install.sh octo-org/sandbox --bot helper-bot --dry-run` gives `error: --user is required`.
  - `--label dry-bad-repo -- scripts/install.sh foo/bar/baz --user octo-user --bot helper-bot --dry-run` gives `error: invalid owner/repo: foo/bar/baz`.
- **Help.** Run `control-mentions drive --run "$id" --label dry-help -- scripts/install.sh --help`. Exit is `0` and stdout lists `--secret-prefix`, `--branch`, `--bot`, and `--dry-run`.
- **Proof.** The `dry-render` step (`stdout.txt`, `gh-calls.txt` empty, `refs-changed.txt` = `none`, `tmp-leftovers.txt` = `none`) plus `$E/mention-forward.yml` and its clean actionlint run.

## Gotchas

- `owner/repo` is classified by whether a path with that name exists relative to the cwd. Drives run from the checkout root, so a directory named like `octo-org/sandbox` there would flip the run into local-path mode.
- `dry-run: no network writes` is printed unconditionally. It is a claim, not proof. Only the step summary proves the skip.
- The dry-run renders through a temp file in `TMPDIR` and deletes it. A non-empty `tmp-leftovers.txt` is a real bug.
- The validation error for `--secret-prefix` includes the allowed pattern. Match the prefix of the line, not the whole line.
