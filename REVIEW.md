# Plugin review: mentions

Reviewed `/workspace/mentions` against the review-plugin-submission checklist (manifest, discovery, component metadata, repository integration, documentation).

## Results

| Section | Result | Notes |
| --- | --- | --- |
| Manifest validity | Pass | `.cursor-plugin/plugin.json` parses. `name` is `mentions` (kebab-case). `version` `1.0.0`, `description`, `author.name` ArchAgents, `author.email`, and `license` `MIT` are coherent. No extra properties. |
| Component discoverability | Pass | Skills are `skills/setup-mentions/SKILL.md` and `skills/handle-mention/SKILL.md`. No rules, agents, commands, hooks, or MCP config are claimed. The workflow template and installer are referenced from those skills and exist. |
| Component metadata | Fail | Both skills have `name` and `description` frontmatter, and each `name` matches its directory. The handle-mention procedure does not say how to tell a pull-request conversation comment from an issue comment, and it does not define `reply_target`, so later progress and final replies are not tied to a concrete API. |
| Repository integration | Pass | Single-plugin repo. There is no `.cursor-plugin/marketplace.json`, and none is required. |
| Documentation quality | Fail | `README.md` states purpose, install, and component coverage. It has no logo. The Development section points at `node /workspace/cursor-plugins/scripts/validate-plugins.mjs`, a machine-local path that is not part of this plugin. |

## Prioritized fixes

1. **Handle-mention threading and replies (component metadata).** State that an `issue_comment` whose payload has `issue.pull_request` uses the pull-request thread key and `issue.number`. Name the number field for every other event. Record `reply_target` as the kind plus the ids the ack API needs, and post milestone and final comments to that same target. Store `last_progress` as the count of milestone lines already posted.
2. **Validator documentation (documentation quality).** Remove the absolute `/workspace/cursor-plugins/...` command from the README and from `scripts/validate-plugin.mjs`. Say that `validate-plugins.mjs` hard-codes the cursor-plugins checkout, requires that repo's marketplace manifest, and imports `ajv`, so it cannot validate this plugin. Point operators at `scripts/validate-plugin.mjs`.

Upstream check used as evidence for fix 2:

```text
$ node /workspace/cursor-plugins/scripts/validate-plugins.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ajv' imported from /workspace/cursor-plugins/scripts/validate-plugins.mjs
exit 1
```

Reading that script shows it would still ignore this repo after `ajv` is installed: `root` is the cursor-plugins directory, and validation starts from `.cursor-plugin/marketplace.json` there.

## Recommendation

Do not submit until the two findings above are fixed. Manifest, discovery, and single-plugin layout are ready.

## Fixes applied

Both findings are fixed.

1. `skills/handle-mention/SKILL.md` now classifies an `issue_comment` with `issue.pull_request` as the pull-request thread, names the number field for every event, records `reply_target` as the ack API's kind and ids, and treats `last_progress` as the count of milestone lines already posted. Progress and final replies use that same target.
2. `README.md` and `scripts/validate-plugin.mjs` no longer tell operators to run a machine-local validator path. They state that the cursor-plugins marketplace script hard-codes its checkout, requires that repo's `marketplace.json`, and imports `ajv`, and they point at `scripts/validate-plugin.mjs`.

Re-checked sections: component metadata Pass, documentation quality Pass. Recommendation after fixes: ready to submit.

Verification after the fixes:

```text
$ shellcheck scripts/install.sh scripts/test.sh
shellcheck_exit:0

$ actionlint
actionlint_exit:0

$ bash scripts/test.sh
ok
test_exit:0

$ node scripts/validate-plugin.mjs
Validated .cursor-plugin/plugin.json and skill frontmatter.
Note: cursor-plugins scripts/validate-plugins.mjs hard-codes that checkout, requires its marketplace.json, and imports ajv. It cannot validate this single-plugin repo. Use scripts/validate-plugin.mjs.
validate_exit:0

$ node /workspace/cursor-plugins/scripts/validate-plugins.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ajv' imported from /workspace/cursor-plugins/scripts/validate-plugins.mjs
upstream_exit:1
```

The upstream exit is expected. That script cannot validate this repository.

