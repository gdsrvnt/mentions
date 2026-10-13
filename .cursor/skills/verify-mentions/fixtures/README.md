# Fixtures

Synthetic identities only: repository `octo-org/sandbox`, trigger user `octo-user`, bot `helper-bot`. Never put a real handle here; the goals gate treats real handles in shipped paths as a failure.

| File | Used by |
| --- | --- |
| `issue_comment-pr-mention.json` | `forward-webhook` and `handle-mention`: `octo-user` mentions `@helper-bot` in a pull-request conversation comment (PR 7, comment 1001). |
| `issue_comment-pr8-mention.json` | `handle-mention` parallel thread: the same user mentions the bot on PR 8 (comment 1002). |
| `issue_comment-stranger.json` | `handle-mention` drop path: same text, sender `someone-else`. |
| `gh/` | Read fixtures for the fake `gh` (`FAKE_GH_FIXTURES` defaults here). `gh api <endpoint>` reads `gh/api/<endpoint with / as __>.json`; `gh pr view N` reads `gh/pr-view-N.json`; `gh pr diff N` reads `gh/pr-diff-N.patch`. A missing fixture answers like a 404. |
