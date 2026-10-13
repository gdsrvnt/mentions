---
name: verify-mentions
description: "Verify the mentions Cursor plugin (GitHub @mention → Actions forwarder → webhook routine → handle-mention skill). First run a goals gate against the product goals (clear install docs, repo quality, works for any user and handle, Grok Bot-native marketplace readiness). Then drive the README install path, the scripts/install.sh setup CLI, the rendered workflow, and the handler in an offline sandbox where gh and herdr are recording fakes. Use before calling a mentions change done, before a release or marketplace submission, or when asked whether the plugin meets its goals."
---

# Verify mentions

`mentions` is a single Cursor plugin (manifest `.cursor-plugin/plugin.json`). A chosen GitHub user mentions a bot; a GitHub Actions workflow posts `{event_name, payload}` to a webhook routine; the `handle-mention` skill acknowledges, posts progress, and replies. Users touch four surfaces:

| Surface | What runs | Feature file |
| --- | --- | --- |
| README install | the shell block a human pastes to load the plugin | [install-plugin](features/install-plugin.md) |
| Setup CLI | `scripts/install.sh`, run directly or by the `setup-mentions` skill | [setup-dry-run](features/setup-dry-run.md), [setup-install](features/setup-install.md) |
| Forwarder | the rendered `.github/workflows/mention-forward.yml` on an Actions runner | [forward-webhook](features/forward-webhook.md) |
| Handler | the `handle-mention` skill run by an agent behind the webhook routine | [handle-mention](features/handle-mention.md) |

Nothing here is a long-running server. Each drive is a short-lived process inside a sandbox the harness creates.

Hard rules for every run:

- Never post to GitHub, X, or anything external. Never run real `gh` with a token, push to a real remote, or set a real secret. The only exception is the handler drive's traffic to its agent's model API, and only with the user's consent (see `features/handle-mention.md`). The harness strips `GH_TOKEN`/`GITHUB_TOKEN`, puts recording fakes for `gh`, `herdr`, and `herdr-heartbeat.sh` first on `PATH`, limits git to `file://` transports, and removes the network with `unshare -rn` when the host allows it.
- Do not edit the checkout under test. The goals gate works on a copy; drives only read the checkout.
- Kill only processes this run started (`cleanup` does it from recorded pids). Never kill by process name.
- Two runs can go side by side: each run has its own id, scratch, and evidence directory.

A run goes in this order: launch (1), doctor (2), goals gate (0), feature drives (3), cleanup (5), report. The gate is numbered 0 because its result comes first in every report, but it needs a launched run to write into.

All commands below run from the repository root with the helpers on `PATH`:

```bash
export PATH="$PWD/.cursor/skills/verify-mentions/scripts:$PATH"
```

## 0. Goals gate (always first)

Check the checkout against the product goals before any feature drive, and report the gate before any drive result.

- **(a)** clear installation instructions
- **(b)** a public repository that reads as finished product work
- **(c)** works for any user and any bot handle, with the script packaged and explained for people and agents
- **(d)** a Grok Bot-native Cursor plugin ready for marketplace submission

The handle hunt has no built-in list. Pass `--handles` or put one regular expression on the first non-comment line of `.cursor/skills/verify-mentions/handles.local`. That file stays uncommitted.

Run it inside a launched run (step 1) so the report lands in that run's evidence:

```bash
control-mentions gate --run "$id"                          # v1.0.x
control-mentions gate --run "$id" --expect-version 1.1.0   # when verifying the v1.1 release
```

`goals-gate.mjs --list` prints every gate. Each gate prints `PASS`, `FAIL`, `WARN` (reported, not failing), `JUDGE` (evidence for you to judge), or `BLOCKED` (could not evaluate, usually a missing tool), followed by its evidence lines and, on `FAIL`, a fix. Exit is `0` with no FAIL or BLOCKED, `1` with any FAIL, and `3` with BLOCKED but no FAIL. The report is `<evidence>/goals/goals-gate.txt` plus `goals-gate.json` and `transcripts/`. Later gate calls in the same run (for example `--only …`) write `goals-2/`, `goals-3/`, and so on, and never overwrite the first report.

| Goal | Gate | Passes when |
| --- | --- | --- |
| a | `a1-install-section` | README has an H2 install / getting-started section with a fenced shell block |
| a | `a2-install-block-runs` | every install path (the H2's blocks, or each H3 under it) runs as pasted in an empty HOME, offline, from a copy of the checkout, and leaves `~/.cursor/plugins/local/<name>` with the manifest and skills |
| a | `a3-install-from-zero` | the install section says how to get the code (`git clone …` or the marketplace) |
| a | `a4-requirements` | README has a requirements / prerequisites section |
| a | `a5-documented-flags` | every `install.sh` flag named in README or skills exists in `--help`, and `--help` exits 0 |
| b | `b1-no-stray-files` | no tracked process leftovers (`DONE.txt`, `REVIEW.md`, `RELEASE.md`, `PROMPT.md`, `*.bak`, `.src/` …) and nothing outside the plugin layout |
| b | `b2-scripts-executable` | every tracked script has a shebang and git mode `100755` |
| b | `b3-local-ci-green` | each single-line `run:` command in `ci.yml` exits 0 offline with no token |
| b | `b4-ci-on-default-branch` | CI runs on `push` to the default branch (WARN if no README badge) |
| b | `b5-no-machine-paths` | no `/workspace/`, `/home/<user>/`, `/Users/` paths in tracked files |
| b | `b6-references-resolve` | relative links, anchors, and backticked repo paths in docs exist (`--online` also fetches external links) |
| b | `b7-no-secrets` | no token-shaped strings in HEAD or history |
| b | `b8-version-consistency` | `plugin.json` version equals the top CHANGELOG entry (and `--expect-version`) |
| b | `b9-license` | LICENSE text matches the manifest license |
| c | `c1-no-personal-handles` | handles from `--handles` or `handles.local` appear in shipped code paths only as identity metadata (manifest author/repository, license line), inside this repo's own `github.com/<owner>/<repo>` URL, or on lines labeled as examples; test denylists are WARN |
| c | `c2-arbitrary-handles` | a dry-run for `octo-user` / `helper-bot` / prefix `ACME` renders those values with nothing personal or default left, and calls no `gh` |
| c | `c3-handler-config-documented` | every key in `handle-mention`'s configuration block is explained in README or a file README links |
| c | `c4-how-it-works` | README has a how-it-works / architecture section covering workflow, webhook, and handler |
| d | `d1-manifest-schema` | `plugin.json` validates against the official plugin schema (vendored in `schemas/`) |
| d | `d2-listing-fields` | manifest has the fields every marketplace listing carries: `displayName`, `description`, `version`, `author`, `license`, `keywords`, `tags`, `category`, `repository`, `homepage`, and a repo-hosted PNG/SVG `logo` |
| d | `d3-grokbot-native` | `minClientVersions.grokbot` is a semver minimum and README covers Grok Bot |
| d | `d4-marketplace-entry` | a `{name, source, description, minClientVersions}` entry validates against the marketplace schema and the name is not already listed |
| d | `d5-components` | skills are discoverable with `name` = directory and a non-empty description of at most 1024 characters |

Then answer the three `JUDGE` gates (`b-judge`, `c-judge`, `d-judge`) in your report. Quote the evidence lines and give a yes or no with one reason each. The script cannot decide these; you must not skip them.

A failing gate does not stop the drives: behavior proof stands on its own. The overall verdict is "meets the v1.1 goals" only when the gate exits 0, every JUDGE answer is yes, and every mapped feature you drove passed.

v1.0.0 is expected to fail several gates; that is what the gate is for. The gate checks against the official marketplace schema and listing conventions as of `cursor/plugins@118e73b`. Refresh them as described in `schemas/SOURCE.md`.

## 1. Launch

```bash
id=$(control-mentions launch | tee /dev/stderr | sed -n 's/^ready: //p')
```

Ready means the last line reads `ready: <id>`. Launch creates:

- an evidence directory `${VERIFY_MENTIONS_EVIDENCE:-~/.local/state/verify-mentions}/<id>/` with `run.env`, `run.txt`, and `steps/`;
- a scratch directory `${VERIFY_MENTIONS_SCRATCH:-${TMPDIR:-/tmp}/verify-mentions}/<id>/` holding the sandbox HOME (with a sandbox git identity), `tmp/`, the recording fakes in `bin/`, local bare `origin/` repos, `state/` call logs, and `pids/`.

`--repo PATH` checks a different checkout. Without it, the run targets the repository that contains this skill. Pass the id to every later command. `--run` also accepts the evidence directory path.

If anyone else (a person or another agent) may commit or switch branches in the checkout during your run, verify a frozen clone of the exact ref instead. Doctor's "HEAD moved since launch" note is the symptom.

```bash
frozen="${TMPDIR:-/tmp}/mentions-frozen-$(git rev-parse --short main)"
git clone -q --branch main "$PWD" "$frozen"
git -C "$frozen" remote set-url origin "$(git remote get-url origin)"   # keeps the gate's repo-URL mapping
id=$(control-mentions launch --repo "$frozen" | tee /dev/stderr | sed -n 's/^ready: //p')
```

## 2. Doctor

```bash
control-mentions doctor --run "$id"
```

Read-only. The last line is `doctor: OK` or `doctor: FAIL (n problem(s))`. It checks that the scratch and evidence directories exist, the repo HEAD (and whether it moved since launch), that `plugin.json` parses, and the versions of bash, git, node, python3, jq, curl, shellcheck, and actionlint. It also confirms the drive `PATH` resolves `gh` and `herdr` to the fakes, reports whether a host GitHub token or git identity env vars are present (drives strip both), whether drives get no network, and any live pids this run left behind. Run doctor first, and again whenever a drive surprises you. A missing scratch directory means the run was already cleaned up, so launch a new one.

## 3. Drive

```bash
control-mentions drive --run "$id" --label <step-name> [--cwd DIR] [--online] [--env K=V]... -- <command> [args...]
```

The command runs from the checkout root (or `--cwd`) with:

- `HOME`, `TMPDIR`, `GIT_CONFIG_GLOBAL`, and `GH_CONFIG_DIR` inside scratch; GitHub tokens unset; the host's `GIT_AUTHOR_*`/`GIT_COMMITTER_*`/`EMAIL`, `GIT_DIR`-style location vars, and ssh/askpass hooks unset, so commits carry the sandbox identity `Sandbox Verifier <sandbox-verifier@example.invalid>`; `GIT_ALLOW_PROTOCOL=file`;
- `PATH` = fakes, then this `scripts/` directory, then the host `PATH`. That means `forward-step.sh` and `webhook-capture.py` resolve by name;
- `MENTIONS_REPO` (the checkout), `VM_STATE`, `VM_STEP` (this step's evidence directory), `VM_ORIGIN`, `VM_FIXTURES` (`fixtures/`), `VM_PIDS`;
- no network unless `--online`. Only the handler drive needs `--online`, because its agent must reach its model API.

The fakes behave like this:

- **Fake `gh`** logs every call. `auth status` succeeds. `repo clone OWNER/REPO` clones the sandbox origin made by `control-mentions origin --run "$id" OWNER/REPO`. `pr create` saves the body as `pr-N-body.md` and prints `https://github.invalid/OWNER/REPO/pull/N`. `secret set` records the name, byte count, and a sha256 prefix, never the value. `api` writes return a fake id. Reads come from `fixtures/gh/`, and a missing fixture answers like a 404. Anything else exits 97.
- **`FAKE_GH_FAIL="pr create"`** (via `--env`) makes that call fail, which exercises install rollback.
- **Fake `herdr`** logs calls and returns minimal JSON. It never opens a tab or starts an agent.

Use `--env` for literal values. For values that must expand inside the sandbox (`$HOME`, `$VM_STEP`), wrap the command in `bash -c '…'` with single quotes.

After the command, drive prints its stdout and stderr, then a step summary: exit code, network mode, `gh`/`git`/`herdr` call counts by subcommand, sandbox origin refs that changed, and new files left in the sandbox `TMPDIR`. Its exit status is the command's.

Recipes per feature live in [`features/`](features/README.md). Start from the index.

## 4. Evidence

Each drive writes `<evidence>/steps/NN-<label>/`:

| File | Content |
| --- | --- |
| `cmd.txt` | the exact argv, cwd, network mode, sandbox env summary |
| `stdout.txt`, `stderr.txt`, `exit.txt` | what the user would see, and the exit code |
| `gh-calls.txt`, `git-calls.txt`, `herdr-calls.txt`, `secrets.txt` | side-effect calls made during this step only |
| `refs-before.txt`, `refs-after.txt`, `refs-changed.txt` | sandbox origin refs around the step |
| `tmp-before.txt`, `tmp-after.txt`, `tmp-leftovers.txt` | temp files the step left behind |
| `pr-N-body.md`, `step.sh`, `requests.jsonl` | PR bodies, the extracted workflow step, and the requests the stand-in routine received (feature-specific) |

The goals gate writes `<evidence>/goals/` (later gate calls write `goals-2/`, …). Cleanup adds `cleanup.txt` and copies the run-wide call logs into the evidence root.

Proof standards:

- Exercise the real user path: the README block as written, `scripts/install.sh` as the docs and skill invoke it, and the rendered workflow's own `run:` script. Do not call internal functions or test-only switches.
- Capture the action and the resulting state: the command, its output, and a second, read-only view of the effect (origin refs, the pushed file content, the captured request).
- Verify side effects alongside output: branches in the sandbox origin, files written, `gh` calls recorded, temp files removed.
- Mock only at production boundaries. GitHub (`gh` and the remote), the Grok Bot routine (`webhook-capture.py`), and herdr are boundaries. Nothing inside the plugin is mocked.
- A dry-run is proven by observation, not by its name. A dry-run step passes only with zero `gh` calls, `git` calls limited to local checks (`check-ref-format`, `rev-parse`), unchanged origin refs, no temp leftovers, and success with no network.
- Report every mapped entry point. Mark any you did not drive as not verified, with the reason. Never report a skipped entry point as covered by a different one.

## 5. Cleanup

```bash
control-mentions cleanup --run "$id"
ls "$(control-mentions evidence --run "$id")"   # still resolves: run.env lives in the evidence dir
```

Cleanup kills only pids recorded under the run's `pids/` whose command line points into this run, then deletes the scratch directory. It keeps the evidence and appends `cleanup.txt`. The last line reads `evidence kept: <dir> (N files, M step(s))`. Run cleanup after every failed attempt too, so broken attempts don't strand processes or scratch. After cleanup, `doctor` reports FAIL for that run. That is expected.

## Helpers

| Helper | Invocation |
| --- | --- |
| `scripts/control-mentions` | `control-mentions launch\|doctor\|gate\|origin\|refs\|drive\|calls\|evidence\|cleanup --run ID …`; `control-mentions --help` |
| `scripts/goals-gate.mjs` | `goals-gate.mjs --repo . --out DIR [--expect-version X] [--only a,b1-no-stray-files] [--online] [--list]`; usually run through `control-mentions gate` |
| `scripts/forward-step.sh` | inside a drive: `forward-step.sh --workflow FILE --event NAME --payload FILE [--header V] [--key V] [--require-header 'Name: value'] [--no-url]` |
| `scripts/webhook-capture.py` | started by `forward-step.sh`; standalone: `python3 -I webhook-capture.py --port-file F --out requests.jsonl [--require-header 'Name: value']` |
| `fixtures/` | synthetic event payloads and `gh` read fixtures (see `fixtures/README.md`) |
| `schemas/` | vendored `plugin.schema.json`, `marketplace.schema.json`, and listed plugin names (see `schemas/SOURCE.md`) |

Requirements: bash 4+, git, node 18+, python3, jq, curl, shellcheck, actionlint. `unshare` (util-linux) gives no-network drives. Without it, drives still cannot reach GitHub, because `gh` is faked and git is limited to `file://`, but doctor says so.

## Report

Lead with the goals gate summary line and every FAIL with its evidence, then your three JUDGE answers. Then, per feature driven, give each entry point and sub-feature as pass or fail with its `steps/NN-…` path. Close with the stand-in limits below that your verdict depends on. Give the evidence directory path.

## Stand-in limits

The sandbox cannot prove these. They stay unverified until someone runs them on the real target (a throwaway GitHub repo, a real Grok Bot routine, a clean Cursor install):

- GitHub's evaluation of the workflow `if:` filter: actor match, case-insensitive mention, and per-event fields. The sandbox lints it and runs the step script; it does not evaluate the expression.
- `pull_request_target` reading secrets from the default branch, and the events firing only after the workflow merges.
- Real `gh auth`, `gh repo clone` over the network, PR creation, branch protection, and `gh secret set` on a real repository.
- Whether the Grok Bot routine accepts the forwarded request with the configured header, and how it invokes `handle-mention`.
- Whether Cursor and Grok Bot actually load the plugin from `~/.cursor/plugins/local/<name>`. The sandbox proves the files land there.
- Cursor marketplace review itself.
