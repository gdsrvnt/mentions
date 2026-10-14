# Forward a mention

When the trigger user mentions the bot on an issue, PR, review, or discussion, the rendered `mention-forward` workflow's only step POSTs `{"event_name", "payload"}` as JSON to the webhook routine. The auth header comes from the configured secrets: either a header name plus a key, or a full `Name: value` header line pasted from the Grok Bot routine panel. Missing secrets fail the step with an `::error::` annotation. A non-2xx response fails the step with `::error::webhook returned HTTP <code>` and exit 1. The step prints the status code only. It does not print the response body.

## Sub-features

- `fwd-lint`: the rendered workflow passes actionlint, subscribes to all seven events, and never checks out code.
- `fwd-post`: the step POSTs `Content-Type: application/json` with exactly `event_name` and the full event `payload`.
- `fwd-header-name`: when the `*_WEBHOOK_HEADER` secret is a bare name such as `X-Webhook-Key`, the step sends `<name>: <key>`.
- `fwd-header-line`: when `*_WEBHOOK_HEADER` contains `:`, the step sends it verbatim, and `*_WEBHOOK_KEY` is optional.
- `fwd-401`: a wrong key gets a 401 from the routine, and the step fails with exit 1 and `::error::webhook returned HTTP 401`. The response body is not printed.
- `fwd-missing-secrets`: a missing URL or header, or a bare header name with no key, fails before any request is sent.
- `fwd-review-request`: a `pull_request_target` `review_requested` event posts when `requested_reviewer.login` is the bot (any case) and exits 0 with `::notice::Review was not requested from <bot>` otherwise. The text boundary is not applied to it. `scripts/test.sh` covers both.
- `fwd-filter`: the job `if:` runs only for the trigger user with `@bot` in the event text. Actions `==` and `contains()` are case-insensitive. The shell boundary still rejects `@bot2`. This is static evidence only (see Gotchas).

## How to get to it (user POV)

- A GitHub user comments `@helper-bot …` on an issue or PR in a repo where the setup PR was merged and the three secrets exist.
- The same for issue/PR/discussion bodies and titles, PR reviews, inline review comments, and discussion comments.
- The user requests a review from `helper-bot` on a PR.

## Driving it with control-mentions

Preconditions:

- `control-mentions doctor --run "$id"` ends with `doctor: OK`.
- `E=$(control-mentions evidence --run "$id")` and `"$E/mention-forward.yml"` exists, saved from a `setup-dry-run` render step (the awk line in that file). Default prefix `MENTION`, user `octo-user`, bot `helper-bot`.
- Fixture `issue_comment-pr-mention.json` (in `fixtures/`; `forward-step.sh` resolves bare names there): `octo-user` comments `@helper-bot …` on PR 7.

- **Lint and shape.** Run `actionlint "$E/mention-forward.yml" && grep -n -E '^  (issues|issue_comment|pull_request_target|pull_request_review|pull_request_review_comment|discussion|discussion_comment):' "$E/mention-forward.yml" && ! grep -n 'actions/checkout' "$E/mention-forward.yml"`. Exit is `0` and all seven event lines print.
- **Header name plus key.** Run `control-mentions drive --run "$id" --label fwd-header-name -- forward-step.sh --workflow "$E/mention-forward.yml" --event issue_comment --payload issue_comment-pr-mention.json --header X-Webhook-Key --key test-key-123 --require-header 'X-Webhook-Key: test-key-123'`. Exit is `0`, stdout has `{"ok":true}` and `1 request(s) captured`, and the summary shows `network: none (unshare -rn)` and `gh calls: 0`.
- **Read what the routine received.** Run `jq -c '{method, path, ct: .headers["Content-Type"], key: .headers["X-Webhook-Key"], event_name, body_json_keys, payload_keys, auth_matched, status}' "$E"/steps/*-fwd-header-name/requests.jsonl`. It shows `"method":"POST"`, `"ct":"application/json"`, `"key":"test-key-123"`, `"event_name":"issue_comment"`, `"body_json_keys":["event_name","payload"]`, `"payload_keys":["action","comment","issue","repository","sender"]`, `"auth_matched":true`, and `"status":200`.
- **Full header line from the routine panel.** Run `control-mentions drive --run "$id" --label fwd-header-line -- forward-step.sh --workflow "$E/mention-forward.yml" --event issue_comment --payload issue_comment-pr-mention.json --header 'Authorization: Bearer test-key-123' --require-header 'Authorization: Bearer test-key-123'`. Exit is `0`, and `requests.jsonl` shows `"Authorization": "Bearer test-key-123"` with `"auth_matched":true`.
- **Wrong key.** Run `control-mentions drive --run "$id" --label fwd-401 -- forward-step.sh --workflow "$E/mention-forward.yml" --event issue_comment --payload issue_comment-pr-mention.json --header X-Webhook-Key --key wrong --require-header 'X-Webhook-Key: test-key-123'`. Exit is `1`, stdout has `::error::webhook returned HTTP 401` and `webhook HTTP` is absent, and `requests.jsonl` shows `"status":401`.
- **Missing URL.** Run `control-mentions drive --run "$id" --label fwd-no-url -- forward-step.sh --workflow "$E/mention-forward.yml" --event issue_comment --payload issue_comment-pr-mention.json --header X-Webhook-Key --key k --no-url`. Exit is `1`, stdout has `::error::MENTION_WEBHOOK_URL and MENTION_WEBHOOK_HEADER must be set`, and `0 request(s) captured`.
- **Header name without key.** Run `control-mentions drive --run "$id" --label fwd-no-key -- forward-step.sh --workflow "$E/mention-forward.yml" --event issue_comment --payload issue_comment-pr-mention.json --header X-Webhook-Key`. Exit is `1`, stdout has `::error::MENTION_WEBHOOK_KEY must be set when MENTION_WEBHOOK_HEADER is only a header name`, and `0 request(s) captured`.
- **Filter, static.** Run `grep -n -E "github.actor == 'octo-user'|contains\\(github.event.comment.body \\|\\| '', '@helper-bot'\\)" "$E/mention-forward.yml"`. Both the actor check and the comment-body mention check print.
- **Proof.** Keep `fwd-header-name/requests.jsonl` and `step.sh` (the exact script that ran), plus the 401 and missing-secret steps.

## Gotchas

- `forward-step.sh` runs the step the way an Ubuntu runner does: `bash --noprofile --norc -eo pipefail`, a clean env, and `RUNNER_TEMP` in the sandbox. It does not evaluate the job `if:`. GitHub's expression engine is not available locally, so `fwd-filter` stays a stand-in limit: prove it on a throwaway repo with a matching and a non-matching comment.
- A different `--secret-prefix` changes the names in the `::error::` lines. Match the prefix used to render `mention-forward.yml`.
- `requests.jsonl` stores the full headers, including the key. Use only synthetic keys.
- The step needs `jq` and `curl` on `PATH`. GitHub runners have both, and doctor checks both locally.
- The stand-in routine compares the auth header exactly. The real Grok Bot routine's comparison rules (case, whitespace) are a stand-in limit.
