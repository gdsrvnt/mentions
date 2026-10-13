# Mentions verification map

This directory is the maintained source for verifying the user-facing behavior of the mentions plugin. Run the goals gate first (SKILL.md step 0). Then read this index and use the matching feature file as the recipe.

## Baseline preconditions

- Work from the repository root with `PATH="$PWD/.cursor/skills/verify-mentions/scripts:$PATH"`.
- `id` holds a run id from `control-mentions launch`, and `control-mentions doctor --run "$id"` ends with `doctor: OK`.
- `control-mentions gate --run "$id"` has run and its summary is in hand.
- Identities are synthetic: repository `octo-org/sandbox`, trigger user `octo-user`, bot `helper-bot`, secret prefix `MENTION` (default) or `ACME`. Never use a real handle, repository, or secret value.
- Never drive anything this run did not create: a real repository, the user's installed plugin, a running herdr session, or a real Grok Bot routine.

## Driving conventions

- Run every user action through `control-mentions drive --run "$id" --label <name> -- <command>`. It is the only path into the sandbox.
- Treat commands as literal. Keep flags, quotes, and the `bash` prefix exactly as written, because the `setup-mentions` skill invokes `bash scripts/install.sh` and the README invokes `scripts/install.sh`.
- Values that must expand inside the sandbox (`$HOME`, `$MENTIONS_REPO`, `$VM_STEP`) go inside `bash -c '…'` with single quotes.
- Create sandbox remotes with `control-mentions origin --run "$id" octo-org/sandbox` before any non-dry-run install. A run gets one origin per name; launch a new run to start from a clean origin.
- Use a new, descriptive `--label` per step. Labels become evidence directory names.

## Proof and skip reporting

- The step summary from `drive` is the primary proof: exit code, `gh`/`git`/`herdr` calls, origin refs changed, temp leftovers, and network mode.
- CLI proof names the command, stdout, stderr, and exit code (`steps/NN-<label>/`).
- Mutation proof adds a second, read-only view: `control-mentions refs`, `git show` on the sandbox origin, or the captured `requests.jsonl`.
- Dry-run proof is observed: zero `gh` calls, only local `git` checks, unchanged refs, no temp leftovers, and success with no network.
- Record the feature id, the sub-feature id, and the entry point with every result.
- Report an unreachable entry point with the attempted command and the unmet precondition. Do not count it as verified through another entry point.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. Then come four H2 sections in this order:

1. `Sub-features`: short ids, one line per behavior.
2. `How to get to it (user POV)`: every user entry point.
3. `Driving it with control-mentions`: starts with `Preconditions:`, then labeled bullets that pair each user action with an exact command and the observable result.
4. `Gotchas`: traps that waste or invalidate a run.

Keep implementation details out of the map. Name only user paths, stable handles (flags, output keys, section markers, file paths), required state, commands, and observable proof.

## Features

| Feature | Covers | Last proven |
| --- | --- | --- |
| [Install the plugin](./install-plugin.md) | README install block in a clean HOME, plugin discovery, skills present | run `20261013T061738Z-373473` on v1.0.0 `0aa8e7e`: **fails**. README block exits 1 (`ln: … No such file or directory`); discover and validate not reached |
| [Preview setup (dry-run)](./setup-dry-run.md) | render, secret prefix, branch, `@` handling, local path, input validation, help, what dry-run skips | run `20261013T061738Z-373473` on v1.0.0 `0aa8e7e`: passes 7/7 (terminal entry and the skill's exact command) |
| [Install the workflow](./setup-install.md) | branch push, PR, secrets routine, rollback on failure, refusal of an existing branch, secrets set by name | run `20261013T061738Z-373473` on v1.0.0 `0aa8e7e`: passes 5/5 |
| [Forward a mention](./forward-webhook.md) | rendered workflow lint, POST shape, header-name and full-header-line secrets, 401, missing secrets | run `20261013T061738Z-373473` on v1.0.0 `0aa8e7e`: passes 6/7; `fwd-filter` is static only (stand-in limit) |
| [Handle a mention](./handle-mention.md) | ack, silent drop, steer, parallel threads, progress, verified final reply | never: needs a consented online agent run |
