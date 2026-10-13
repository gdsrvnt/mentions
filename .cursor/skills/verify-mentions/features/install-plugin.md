# Install the plugin

A new user follows the README to put the plugin where Cursor and Grok Bot load local plugins (`~/.cursor/plugins/local/mentions`), then starts a new session and sees the `setup-mentions` and `handle-mention` skills.

## Sub-features

- `install-paste` runs every README install block exactly as written, from a fresh shell and an empty HOME.
- `install-get-code` gets the code from nothing (clone or marketplace), without assuming a checkout already exists.
- `install-discover` leaves a directory under `~/.cursor/plugins/local/` whose `.cursor-plugin/plugin.json` names `mentions` and whose `skills/*/SKILL.md` exist.
- `install-validate` passes the repo's own validator from the installed location.

## How to get to it (user POV)

- README.md, the first H2 install section (v1.0.0: `## Install the plugin`), pasted into a terminal.
- The Cursor marketplace listing, once published (not reachable in the sandbox).

## Driving it with control-mentions

Preconditions:

- `control-mentions doctor --run "$id"` ends with `doctor: OK`.
- You have re-read the current README install section. The verbatim drive below must use today's block, not the v1.0.0 one quoted here.

- **Paste every install path automatically.** Run `control-mentions gate --run "$id" --only a2-install-block-runs,a3-install-from-zero`. Each path is the H2's shell blocks, or each H3 under it with the H2 blocks as a shared prefix. The gate runs each path offline in an empty HOME, from a copy of the checkout. PASS means exit 0 and a discovered plugin with skills. Transcripts land in `<evidence>/goals-N/transcripts/a2-install-path*.txt`. The path is printed on the last line.
- **Paste the block verbatim as a user would.** Clone first, then paste the README block unchanged after `cd`. Run `control-mentions drive --run "$id" --label install-paste -- bash -euo pipefail -c 'git clone -q "$MENTIONS_REPO" "$HOME/src/mentions" && cd "$HOME/src/mentions" && ln -s "$(pwd)" ~/.cursor/plugins/local/mentions'`. Replace everything after the last `&&` with today's README block. The exit code is `0`.
- **Confirm discovery.** List what landed. Run `control-mentions drive --run "$id" --label install-discover -- bash -c 'ls -la ~/.cursor/plugins/local/ && jq -r .name ~/.cursor/plugins/local/mentions/.cursor-plugin/plugin.json && ls ~/.cursor/plugins/local/mentions/skills/*/SKILL.md'`. The output shows `mentions` and both `SKILL.md` paths.
- **Validate the installed copy.** Run `control-mentions drive --run "$id" --label install-validate -- bash -c 'node ~/.cursor/plugins/local/mentions/scripts/validate-plugin.mjs'`. Exit code is `0` and stdout reads `Validated .cursor-plugin/plugin.json and skill frontmatter.`
- **Proof.** Keep the `install-paste` and `install-discover` steps and the a2 transcripts. Together they show the action, the resulting directory, and the manifest name.

## Gotchas

- v1.0.0 fails `install-paste`: `ln: failed to create symbolic link '…/.cursor/plugins/local/mentions': No such file or directory`, because nothing creates `~/.cursor/plugins/local` first. Report the failure. Do not add `mkdir -p` to the drive to make it pass.
- When `install-paste` fails, do not run `install-discover` or `install-validate` against a half-installed HOME. Report them as not reached, and give the paste failure as the reason.
- v1.0.0's block is `ln -s "$(pwd)"`, which only works from inside a checkout the README never tells you to create. The clone in the drive is scaffolding for that gap, and `a3-install-from-zero` reports the gap itself.
- The drive clones `$MENTIONS_REPO`, so it sees HEAD, not uncommitted edits. The gate's a2 copies the working tree. When they disagree, check `git status`.
- An install block that clones from GitHub reaches no network in the sandbox. The gate maps the repo's own `https://github.com/<slug>` and `git@github.com:<slug>` URLs to the local checkout. Any other URL fails with git's `transport 'https' not allowed`.
- The sandbox proves the files land. It cannot prove that Cursor or Grok Bot loads them; list that under stand-in limits.
