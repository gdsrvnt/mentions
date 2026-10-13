# Agents

## Tests

From the repository root:

```bash
shellcheck scripts/install.sh scripts/test.sh
actionlint
bash scripts/test.sh
node --test tests/route-event.test.mjs
node scripts/validate-plugin.mjs
```

`actionlint` 1.7.12 must be on `PATH`. `scripts/test.sh` renders the workflow and posts it at a local stub. It does not call GitHub.

## Invariants

`scripts/route-event.mjs` is the accept decision. The skill calls it. Do not re-implement sender, mention, or thread rules only in prose.

`scripts/install.sh` does not change global git config, does not call `gh` on `--dry-run`, and deletes a remote branch only when that run pushed it and the pull request does not exist yet.

Comment text is never interpolated into a shell command. Posts use `-F body=@file`.

## Do not commit

Do not commit `.cursor/`. That tree is local tooling. Do not commit tokens, machine-local absolute paths, or a person's login inside `scripts/`, `skills/`, `templates/`, or the workflow. The manifest author and the license copyright are the maintainer identity. Everywhere else, use the values the command was given.
