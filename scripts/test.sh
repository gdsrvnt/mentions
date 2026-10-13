#!/usr/bin/env bash
# Dry-run install.sh against a local scratch bare repo, assert the render,
# and run actionlint on the rendered workflow.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${script_dir}/.." && pwd)"
install="${root}/scripts/install.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

tmp="$(mktemp -d)"
export TMPDIR="$tmp"
trap 'rm -rf "$tmp"' EXIT

# A fresh clone does not inherit the runner's local identity. actions/checkout
# sets user.name only on the workspace repo, so the installer would die before
# it can push and roll back.
gitconfig="${tmp}/gitconfig"
cat > "$gitconfig" << 'EOF'
[user]
	name = Test User
	email = test@example.invalid
EOF
export GIT_CONFIG_GLOBAL="$gitconfig"

if ! command -v actionlint >/dev/null 2>&1; then
  fail "actionlint is required"
fi
if ! command -v git >/dev/null 2>&1; then
  fail "git is required"
fi
if ! command -v jq >/dev/null 2>&1; then
  fail "jq is required"
fi

assert_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -F -q -- "$pattern" "$file"; then
    fail "missing [${pattern}] in ${file}"
  fi
}

assert_not_contains() {
  local file="$1"
  local pattern="$2"
  if grep -F -q -- "$pattern" "$file"; then
    fail "unexpected [${pattern}] in ${file}"
  fi
}

expect_fail() {
  local status
  set +e
  "$@" >"${tmp}/expect.out" 2>"${tmp}/expect.err"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    fail "expected non-zero exit: $*"
  fi
}

extract_between() {
  local file="$1"
  local start="$2"
  local end="$3"
  local dest="$4"
  awk -v start="$start" -v end="$end" '
    $0 == start {flag=1; next}
    $0 == end {flag=0; next}
    flag {print}
  ' "$file" > "$dest"
}

seed_bare() {
  local bare="$1"
  local work="$2"
  git init -q -b main "$work"
  printf '%s\n' "seed" > "${work}/README.md"
  git -C "$work" add README.md
  git -C "$work" -c user.name="Mentions Test" -c user.email="mentions-test@example.com" commit -q -m "seed"
  git init -q --bare "$bare"
  git -C "$bare" symbolic-ref HEAD refs/heads/main
  git -C "$work" remote add origin "$bare"
  git -C "$work" push -q origin main
}

bare="${tmp}/origin.git"
work="${tmp}/seed"
seed_bare "$bare" "$work"
git -C "$bare" show-ref | sort > "${tmp}/refs-before"

dry_out="${tmp}/dry.out"
"$install" "$bare" --user Alice --bot my-bot --dry-run > "$dry_out"
git -C "$bare" show-ref | sort > "${tmp}/refs-after-dry"
if ! cmp -s "${tmp}/refs-before" "${tmp}/refs-after-dry"; then
  fail "bare repo refs changed during dry-run"
fi

assert_contains "$dry_out" "mode: dry-run"
assert_contains "$dry_out" "trigger_user: Alice"
assert_contains "$dry_out" "bot_handle: my-bot"
assert_contains "$dry_out" "mention: @my-bot"
assert_contains "$dry_out" "secret_url: MENTION_WEBHOOK_URL"
assert_contains "$dry_out" "secret_key: MENTION_WEBHOOK_KEY"
assert_contains "$dry_out" "secret_header: MENTION_WEBHOOK_HEADER"
assert_contains "$dry_out" "branch: mentions/my-bot-forward"
assert_contains "$dry_out" "workflow_path: .github/workflows/mention-forward.yml"
assert_contains "$dry_out" "dry-run: no network writes"
assert_contains "$dry_out" "commit_comment"
assert_contains "$dry_out" "event_name"
assert_contains "$dry_out" "payload"
assert_not_contains "$dry_out" "__MENTIONS_"

wf="${tmp}/mention-forward.yml"
extract_between "$dry_out" "===== RENDERED WORKFLOW =====" "===== END RENDERED WORKFLOW =====" "$wf"
if [[ ! -s "$wf" ]]; then
  fail "rendered workflow was not extracted"
fi
assert_contains "$wf" "name: mention-forward"
assert_contains "$wf" "github.actor == 'Alice'"
assert_contains "$wf" "'@my-bot'"
assert_contains "$wf" "secrets.MENTION_WEBHOOK_URL"
assert_contains "$wf" "secrets.MENTION_WEBHOOK_KEY"
assert_contains "$wf" "secrets.MENTION_WEBHOOK_HEADER"
assert_contains "$wf" "pull_request_target:"
assert_contains "$wf" "issue_comment:"
assert_contains "$wf" "pull_request_review:"
assert_contains "$wf" "pull_request_review_comment:"
assert_contains "$wf" "discussion:"
assert_contains "$wf" "discussion_comment:"
assert_contains "$wf" "issues:"
assert_contains "$wf" "commit_comment is not an Actions trigger"
assert_contains "$wf" "types: [created, edited]"
assert_not_contains "$wf" "--fail-with-body"
assert_not_contains "$wf" "case-sensitive"
assert_contains "$wf" "pull_request"
assert_contains "$wf" "{event_name: \$event_name, payload: \$payload[0]}"
assert_not_contains "$wf" "actions/checkout"
assert_not_contains "$wf" "__MENTIONS_"

lint_dir="${tmp}/lint/.github/workflows"
mkdir -p "$lint_dir"
cp "$wf" "${lint_dir}/mention-forward.yml"
actionlint "${lint_dir}/mention-forward.yml"

prefix_out="${tmp}/prefix.out"
"$install" "$bare" --user Alice --bot my-bot --secret-prefix CUSTOM --dry-run > "$prefix_out"
assert_contains "$prefix_out" "secret_url: CUSTOM_WEBHOOK_URL"
assert_contains "$prefix_out" "secret_key: CUSTOM_WEBHOOK_KEY"
assert_contains "$prefix_out" "secret_header: CUSTOM_WEBHOOK_HEADER"
assert_contains "$prefix_out" "secrets.CUSTOM_WEBHOOK_URL"
assert_not_contains "$prefix_out" "GROKBOT"

branch_out="${tmp}/branch.out"
"$install" "$bare" --user Alice --bot "@my-bot" --branch "feature/mentions" --dry-run > "$branch_out"
assert_contains "$branch_out" "bot_handle: my-bot"
assert_contains "$branch_out" "branch: feature/mentions"
assert_not_contains "$branch_out" "mentions/@my-bot"

short_out="${tmp}/short.out"
"$install" "example/mentions" --user Z --bot a --secret-prefix A --dry-run > "$short_out"
assert_contains "$short_out" "secret_url: A_WEBHOOK_URL"
assert_contains "$short_out" "github.actor == 'Z'"
assert_contains "$short_out" "'@a'"
assert_not_contains "$short_out" "Alice"
assert_not_contains "$short_out" "my-bot"
assert_not_contains "$short_out" "MENTION_WEBHOOK"
assert_not_contains "$short_out" "GROKBOT"
assert_not_contains "$short_out" "__MENTIONS_"

expect_fail "$install"
expect_fail "$install" --user Alice --bot my-bot --dry-run
expect_fail "$install" "$bare" --bot my-bot --dry-run
expect_fail "$install" "$bare" --user Alice --dry-run
expect_fail "$install" "$bare" --user "-bad" --bot my-bot --dry-run
expect_fail "$install" "$bare" --user Alice --bot "bad handle" --dry-run
expect_fail "$install" "$bare" --user Alice --bot my_bot --dry-run
expect_fail "$install" "not a repo" --user Alice --bot my-bot --dry-run
expect_fail "$install" "foo/bar/baz" --user Alice --bot my-bot --dry-run
expect_fail "$install" "../secret" --user Alice --bot my-bot --dry-run
expect_fail "$install" "$bare" --user Alice --bot my-bot --secret-prefix "lower" --dry-run
expect_fail "$install" "$bare" --user Alice --bot my-bot --secret-prefix "GROKBOT_" --dry-run
expect_fail "$install" "$bare" --user Alice --bot my-bot --secret-prefix "1BOT" --dry-run
expect_fail "$install" "$bare" --user Alice --bot my-bot --branch "-bad" --dry-run
expect_fail "$install" "$bare" --user Alice --bot my-bot --branch "has space" --dry-run
expect_fail "$install" "$bare" --user my-bot --bot my-bot --dry-run
expect_fail "$install" "$bare" --user My-Bot --bot my-bot --dry-run
expect_fail "$install" "$bare" --user Alice --user Bob --bot my-bot --dry-run
expect_fail "$install" "$bare" --user Alice --bot my-bot --nope
expect_fail "$install" "$bare" --dry-run
expect_fail "$install" "$tmp" --user Alice --bot my-bot
expect_fail "$install" "example/mentions" --user Alice --bot my-bot
expect_fail "$install" "$bare" --user Alice --bot my-bot --comments-only --commit-name Bot --dry-run
help_out="${tmp}/help.out"
"$install" --help > "$help_out"
assert_contains "$help_out" "--dry-run"
assert_contains "$help_out" "--secret-prefix"
assert_contains "$help_out" "--update"
assert_contains "$help_out" "--comment-as"
assert_contains "$help_out" "--config"
assert_contains "$help_out" "--commit-name"
assert_contains "$help_out" "--commit-email"
assert_contains "$help_out" "--comments-only"
assert_contains "$help_out" "Pull requests write"
"$install" -h > "${tmp}/help-short.out"

stamp="${tmp}/network-stamp"
netbin="${tmp}/netbin"
mkdir -p "$netbin"
real_git="$(command -v git)"
cat > "${netbin}/git" << EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "check-ref-format" ]]; then
  exec "${real_git}" "\$@"
fi
printf '%s\n' "unexpected git: \$*" >> "${stamp}"
exit 99
EOF
cat > "${netbin}/gh" << EOF
#!/usr/bin/env bash
printf '%s\n' "unexpected gh: \$*" >> "${stamp}"
exit 99
EOF
chmod +x "${netbin}/git" "${netbin}/gh"
PATH="${netbin}:${PATH}" "$install" "example/mentions" --user Alice --bot my-bot --dry-run > "${tmp}/net.out"
if [[ -e "$stamp" ]]; then
  fail "dry-run performed a network git or gh call: $(cat "$stamp")"
fi

rollback_err="${tmp}/rollback.err"
rollback_out="${tmp}/rollback.out"
fakebin="${tmp}/fakebin"
mkdir -p "$fakebin"
cat > "${fakebin}/gh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then
  exit 0
fi
if [[ "${1:-}" == "api" ]]; then
  case "${2:-}" in
    users/*) printf '%s\n' "Alice"; exit 0 ;;
    repos/*) printf '%s\n' '{"permissions":{"push":true}}'; exit 0 ;;
  esac
  printf 'unexpected api: %s\n' "$*" >&2
  exit 1
fi
if [[ "${1:-}" == "repo" && "${2:-}" == "clone" ]]; then
  dest="${4:?dest}"
  git clone --quiet "${MENTIONS_TEST_BARE:?}" "$dest"
  exit 0
fi
if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
  printf '%s\n' "null"
  exit 0
fi
printf 'fake gh refusing: %s\n' "$*" >&2
exit 1
EOF
chmod +x "${fakebin}/gh"
set +e
PATH="${fakebin}:${PATH}" MENTIONS_TEST_BARE="$bare" "$install" "example/mentions" --user Alice --bot my-bot --commit-name "Mentions Bot" --commit-email "bot@example.com" > "$rollback_out" 2>"$rollback_err"
rollback_status=$?
set -e
if [[ "$rollback_status" -eq 0 ]]; then
  fail "expected failure when pull request creation fails"
fi
if git -C "$bare" show-ref --verify --quiet refs/heads/mentions/my-bot-forward; then
  fail "remote branch survived rollback"
fi
assert_contains "$rollback_err" "rollback: deleting remote branch mentions/my-bot-forward"
assert_contains "$rollback_err" "rollback: removing temp clone"
assert_contains "$rollback_err" "pull request was not created"
temp_path="$(sed -n 's/^temp-clone: //p' "$rollback_err" | head -n 1)"
if [[ -z "$temp_path" ]]; then
  fail "temp-clone path was not printed"
fi
if [[ -d "$temp_path" ]]; then
  fail "temp clone was not removed: ${temp_path}"
fi
git -C "$bare" show-ref | sort > "${tmp}/refs-after-rollback"
if ! cmp -s "${tmp}/refs-before" "${tmp}/refs-after-rollback"; then
  fail "bare repo refs differ after rollback"
fi

if grep -n -E 'git config (--global|--system)' "$install"; then
  fail "install.sh changes git config"
fi

forward_sh="${tmp}/forward.sh"
awk '
  $0 ~ /# mentions-forward-script/ {flag=1; next}
  $0 ~ /# end mentions-forward-script/ {flag=0; next}
  flag { sub(/^          /, ""); print }
' "$wf" > "$forward_sh"
if [[ ! -s "$forward_sh" ]]; then
  fail "forward script was not extracted"
fi

event_file="${tmp}/event.json"
printf '%s\n' '{"comment":{"body":"@my-bot please look"},"issue":{"number":1,"title":"t","body":""}}' > "$event_file"
boundary_file="${tmp}/boundary.json"
printf '%s\n' '{"comment":{"body":"ask @my-bot2 later"},"issue":{"number":1,"title":"t","body":""}}' > "$boundary_file"

curl_bin="${tmp}/curlbin"
mkdir -p "$curl_bin"
cat > "${curl_bin}/curl" << 'EOF'
#!/usr/bin/env bash
# Records the headers the forward step passes to curl and prints 204.
# A live socket is unreachable in a fresh network namespace, and the macOS
# python3 starter does not bind one before the test gives up.
set -euo pipefail
headers_file="${MENTIONS_CAPTURE:?}"
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -H)
      printf '%s\n' "$2" >> "$headers_file"
      shift 2
      ;;
    -o)
      out="$2"
      shift 2
      ;;
    -w|-X|--data-binary)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [[ -n "$out" ]]; then
  printf '%s\n' "ok" > "$out"
fi
printf '%s' "204"
EOF
chmod +x "${curl_bin}/curl"

post_forward() {
  header="$1"
  key="$2"
  event_name="$3"
  event_path="$4"
  capture="${tmp}/capture.txt"
  : > "$capture"
  set +e
  PATH="${curl_bin}:${PATH}" \
    MENTIONS_CAPTURE="$capture" \
    EVENT_NAME="$event_name" \
    GITHUB_EVENT_PATH="$event_path" \
    WEBHOOK_URL="http://127.0.0.1/hook" \
    WEBHOOK_HEADER="$header" \
    WEBHOOK_KEY="$key" \
    RUNNER_TEMP="${tmp}/runner" \
    bash "$forward_sh" > "${tmp}/forward.out" 2> "${tmp}/forward.err"
  forward_status=$?
  set -e
}

mkdir -p "${tmp}/runner"
post_forward "Authorization: Bearer test-token" "" "issue_comment" "$event_file"
if [[ "$forward_status" != "0" ]]; then
  fail "full Authorization line failed: $(cat "${tmp}/forward.err" "${tmp}/forward.out")"
fi
assert_contains "${tmp}/capture.txt" "Bearer test-token"
assert_contains "${tmp}/forward.out" "webhook HTTP 204"
if grep -q "test-token" "${tmp}/forward.out" "${tmp}/forward.err"; then
  fail "forward step printed the webhook response or the token"
fi

post_forward "X-Webhook-Key" "k" "issue_comment" "$event_file"
if [[ "$forward_status" != "0" ]]; then
  fail "name plus key failed: $(cat "${tmp}/forward.err" "${tmp}/forward.out")"
fi
assert_contains "${tmp}/capture.txt" "X-Webhook-Key: k"

set +e
EVENT_NAME="issue_comment" \
  GITHUB_EVENT_PATH="$event_file" \
  WEBHOOK_URL="http://127.0.0.1:9/hook" \
  WEBHOOK_HEADER="X-Webhook-Key" \
  WEBHOOK_KEY="" \
  RUNNER_TEMP="${tmp}/runner" \
  bash "$forward_sh" > "${tmp}/nokey.out" 2> "${tmp}/nokey.err"
nokey_status=$?
set -e
if [[ "$nokey_status" -eq 0 ]]; then
  fail "a header name without a key should fail"
fi
assert_contains "${tmp}/nokey.out" "MENTION_WEBHOOK_KEY must be set when MENTION_WEBHOOK_HEADER is only a header name"

set +e
EVENT_NAME="pull_request_review" \
  GITHUB_EVENT_PATH="$event_file" \
  WEBHOOK_URL="" \
  WEBHOOK_HEADER="" \
  WEBHOOK_KEY="" \
  RUNNER_TEMP="${tmp}/runner" \
  bash "$forward_sh" > "${tmp}/fork.out" 2> "${tmp}/fork.err"
fork_status=$?
set -e
if [[ "$fork_status" -ne 0 ]]; then
  fail "missing secrets on a review should exit 0"
fi
assert_contains "${tmp}/fork.out" "Fork reviews are not forwarded"

# The boundary fixture does not mention @my-bot. The review event above reused
# the mention fixture so the boundary check would pass and the secret check runs.
set +e
EVENT_NAME="issue_comment" \
  GITHUB_EVENT_PATH="$boundary_file" \
  WEBHOOK_URL="http://127.0.0.1:9/hook" \
  WEBHOOK_HEADER="X-Webhook-Key" \
  WEBHOOK_KEY="k" \
  RUNNER_TEMP="${tmp}/runner" \
  bash "$forward_sh" > "${tmp}/bound.out" 2> "${tmp}/bound.err"
bound_status=$?
set -e
if [[ "$bound_status" -ne 0 ]]; then
  fail "a non-boundary mention should exit 0"
fi
assert_contains "${tmp}/bound.out" "Mention boundary check failed"

canon_bin="${tmp}/canonbin"
mkdir -p "$canon_bin"
cat > "${canon_bin}/gh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then
  exit 0
fi
if [[ "${1:-}" == "api" ]]; then
  case "${2:-}" in
    users/*) printf '%s\n' "alice"; exit 0 ;;
    repos/*) printf '%s\n' '{"permissions":{"push":true}}'; exit 0 ;;
  esac
  printf 'unexpected api: %s\n' "$*" >&2
  exit 1
fi
if [[ "${1:-}" == "repo" && "${2:-}" == "clone" ]]; then
  dest="${4:?dest}"
  git clone --quiet "${MENTIONS_TEST_BARE:?}" "$dest"
  exit 0
fi
if [[ "${1:-}" == "pr" && "${2:-}" == "create" ]]; then
  printf '%s\n' "https://example.invalid/pull/1"
  exit 0
fi
printf 'fake gh refusing: %s\n' "$*" >&2
exit 1
EOF
chmod +x "${canon_bin}/gh"
canon_cfg="${tmp}/canon-config.json"
printf '%s\n' '{"repos":["other/repo"],"trigger_user":"old"}' > "$canon_cfg"
PATH="${canon_bin}:${PATH}" MENTIONS_TEST_BARE="$bare" MENTIONS_CONFIG="$canon_cfg" \
  "$install" "example/mentions" --user Alice --bot my-bot --commit-name "Mentions Bot" --commit-email "bot@example.com" > "${tmp}/canon.out" 2>"${tmp}/canon.err"
canon_wf="$(git -C "$bare" show "mentions/my-bot-forward:.github/workflows/mention-forward.yml")"
printf '%s\n' "$canon_wf" > "${tmp}/canon-wf.yml"
assert_contains "${tmp}/canon-wf.yml" "github.actor == 'alice'"
assert_contains "${tmp}/canon.out" "trigger_user: alice"
if ! jq -e '(.repos | index("example/mentions")) != null and (.repos | index("other/repo")) != null and .trigger_user == "alice" and .commit_name == "Mentions Bot" and .commit_email == "bot@example.com"' "$canon_cfg" >/dev/null; then
  fail "config did not merge repos or canonicalize the user: $(cat "$canon_cfg")"
fi
ident_repo="${tmp}/ident-repo"
git init -q -b main "$ident_repo"
printf '%s\n' "note" > "${ident_repo}/note.txt"
git -C "$ident_repo" add note.txt
git -C "$ident_repo" -c user.name="$(jq -r .commit_name "$canon_cfg")" -c user.email="$(jq -r .commit_email "$canon_cfg")" commit -q -m "commit with the installer identity"

update_bare="${tmp}/update.git"
update_work="${tmp}/update-seed"
seed_bare "$update_bare" "$update_work"
mkdir -p "${update_work}/.github/workflows"
printf '%s\n' "name: old" > "${update_work}/.github/workflows/mention-forward.yml"
git -C "$update_work" add .github/workflows/mention-forward.yml
git -C "$update_work" -c user.name="Mentions Test" -c user.email="mentions-test@example.com" commit -q -m "add old workflow"
git -C "$update_work" push -q origin main
update_err="${tmp}/update-refuse.err"
set +e
PATH="${canon_bin}:${PATH}" MENTIONS_TEST_BARE="$update_bare" MENTIONS_CONFIG="${tmp}/update-config.json" \
  "$install" "example/mentions" --user Alice --bot my-bot --commit-name "Mentions Bot" --commit-email "bot@example.com" > "${tmp}/update-refuse.out" 2>"$update_err"
update_status=$?
set -e
if [[ "$update_status" -eq 0 ]]; then
  fail "install should refuse an existing workflow without --update"
fi
assert_contains "$update_err" "re-run with --update"
PATH="${canon_bin}:${PATH}" MENTIONS_TEST_BARE="$update_bare" MENTIONS_CONFIG="${tmp}/update-config.json" \
  "$install" "example/mentions" --user Alice --bot my-bot --commit-name "Mentions Bot" --commit-email "bot@example.com" --update > "${tmp}/update.out" 2>"${tmp}/update.err"
update_wf="$(git -C "$update_bare" show "mentions/my-bot-forward:.github/workflows/mention-forward.yml")"
printf '%s\n' "$update_wf" > "${tmp}/update-wf.yml"
assert_contains "${tmp}/update-wf.yml" "github.actor == 'alice'"
assert_contains "${tmp}/update-wf.yml" "name: mention-forward"
assert_contains "${tmp}/update.out" "pull_request:"

lost_bare="${tmp}/lost.git"
lost_work="${tmp}/lost-seed"
seed_bare "$lost_bare" "$lost_work"
lost_bin="${tmp}/lostbin"
mkdir -p "$lost_bin"
cat > "${lost_bin}/gh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then
  exit 0
fi
if [[ "${1:-}" == "api" ]]; then
  case "${2:-}" in
    users/*) printf '%s\n' "alice"; exit 0 ;;
    repos/*) printf '%s\n' '{"permissions":{"push":true}}'; exit 0 ;;
  esac
  exit 1
fi
if [[ "${1:-}" == "repo" && "${2:-}" == "clone" ]]; then
  dest="${4:?dest}"
  git clone --quiet "${MENTIONS_TEST_BARE:?}" "$dest"
  exit 0
fi
if [[ "${1:-}" == "pr" && "${2:-}" == "create" ]]; then
  printf '%s\n' "https://example.invalid/pull/9" > "${MENTIONS_LOST_URL:?}"
  exit 1
fi
if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
  cat "${MENTIONS_LOST_URL:?}"
  exit 0
fi
printf 'fake gh refusing: %s\n' "$*" >&2
exit 1
EOF
chmod +x "${lost_bin}/gh"
lost_url="${tmp}/lost.url"
PATH="${lost_bin}:${PATH}" MENTIONS_TEST_BARE="$lost_bare" MENTIONS_LOST_URL="$lost_url" MENTIONS_CONFIG="${tmp}/lost-config.json" \
  "$install" "example/mentions" --user Alice --bot my-bot --commit-name "Mentions Bot" --commit-email "bot@example.com" > "${tmp}/lost.out" 2>"${tmp}/lost.err"
if ! git -C "$lost_bare" show-ref --verify --quiet refs/heads/mentions/my-bot-forward; then
  fail "branch was deleted after a lost pull request response: $(cat "${tmp}/lost.err")"
fi
assert_contains "${tmp}/lost.err" "https://example.invalid/pull/9"
assert_contains "${tmp}/lost.err" "kept branch mentions/my-bot-forward"

closed_bare="${tmp}/closed.git"
closed_work="${tmp}/closed-seed"
seed_bare "$closed_bare" "$closed_work"
closed_bin="${tmp}/closedbin"
mkdir -p "$closed_bin"
cat > "${closed_bin}/gh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then
  exit 0
fi
if [[ "${1:-}" == "api" ]]; then
  case "${2:-}" in
    users/*) printf '%s\n' "alice"; exit 0 ;;
    repos/*) printf '%s\n' '{"permissions":{"push":true}}'; exit 0 ;;
  esac
  exit 1
fi
if [[ "${1:-}" == "repo" && "${2:-}" == "clone" ]]; then
  dest="${4:?dest}"
  git clone --quiet "${MENTIONS_TEST_BARE:?}" "$dest"
  exit 0
fi
if [[ "${1:-}" == "pr" && "${2:-}" == "create" ]]; then
  exit 1
fi
if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
  if [[ "$*" == *"--state all"* ]]; then
    printf '%s\n' "https://example.invalid/pull/3"
    exit 0
  fi
  printf '%s\n' "null"
  exit 0
fi
printf 'fake gh refusing: %s\n' "$*" >&2
exit 1
EOF
chmod +x "${closed_bin}/gh"
PATH="${closed_bin}:${PATH}" MENTIONS_TEST_BARE="$closed_bare" MENTIONS_CONFIG="${tmp}/closed-config.json" \
  "$install" "example/mentions" --user Alice --bot my-bot --commit-name "Mentions Bot" --commit-email "bot@example.com" > "${tmp}/closed.out" 2>"${tmp}/closed.err"
if ! git -C "$closed_bare" show-ref --verify --quiet refs/heads/mentions/my-bot-forward; then
  fail "branch was deleted although a closed pull request exists: $(cat "${tmp}/closed.err")"
fi
assert_contains "${tmp}/closed.err" "https://example.invalid/pull/3"
assert_contains "${tmp}/closed.err" "kept branch mentions/my-bot-forward"

denied_bare="${tmp}/denied.git"
denied_work="${tmp}/denied-seed"
seed_bare "$denied_bare" "$denied_work"
denied_bin="${tmp}/deniedbin"
mkdir -p "$denied_bin"
cat > "${denied_bin}/gh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then
  exit 0
fi
if [[ "${1:-}" == "api" ]]; then
  case "${2:-}" in
    users/*) printf '%s\n' "alice"; exit 0 ;;
    repos/*) printf '%s\n' '{"permissions":{"push":true,"pull_requests":false}}'; exit 0 ;;
  esac
  exit 1
fi
if [[ "${1:-}" == "repo" && "${2:-}" == "clone" ]]; then
  dest="${4:?dest}"
  git clone --quiet "${MENTIONS_TEST_BARE:?}" "$dest"
  exit 0
fi
printf 'fake gh refusing: %s\n' "$*" >&2
exit 1
EOF
chmod +x "${denied_bin}/gh"
set +e
PATH="${denied_bin}:${PATH}" MENTIONS_TEST_BARE="$denied_bare" MENTIONS_CONFIG="${tmp}/denied-config.json" \
  "$install" "example/mentions" --user Alice --bot my-bot --commit-name "Mentions Bot" --commit-email "bot@example.com" > "${tmp}/denied.out" 2>"${tmp}/denied.err"
denied_status=$?
set -e
if [[ "$denied_status" -eq 0 ]]; then
  fail "install should stop when Pull requests write is missing"
fi
if git -C "$denied_bare" show-ref --verify --quiet refs/heads/mentions/my-bot-forward; then
  fail "install pushed before the Pull requests permission check"
fi
assert_contains "${tmp}/denied.err" "Pull requests write"

sig_bare="${tmp}/sig.git"
sig_work="${tmp}/sig-seed"
seed_bare "$sig_bare" "$sig_work"
sig_bin="${tmp}/sigbin"
mkdir -p "$sig_bin"
sig_url="${tmp}/sig.url"
sig_pid="${tmp}/sig.pid"
cat > "${sig_bin}/gh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then
  exit 0
fi
if [[ "${1:-}" == "api" ]]; then
  case "${2:-}" in
    users/*) printf '%s\n' "alice"; exit 0 ;;
    repos/*) printf '%s\n' '{"permissions":{"push":true}}'; exit 0 ;;
  esac
  exit 1
fi
if [[ "${1:-}" == "repo" && "${2:-}" == "clone" ]]; then
  dest="${4:?dest}"
  git clone --quiet "${MENTIONS_TEST_BARE:?}" "$dest"
  exit 0
fi
if [[ "${1:-}" == "pr" && "${2:-}" == "create" ]]; then
  printf '%s\n' "https://example.invalid/pull/4" > "${MENTIONS_SIG_URL:?}"
  sleep 60 &
  printf '%s\n' "$!" > "${MENTIONS_SIG_PID:?}"
  wait "$!"
  exit 1
fi
if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
  if [[ -s "${MENTIONS_SIG_URL:?}" ]]; then
    cat "${MENTIONS_SIG_URL}"
    exit 0
  fi
  printf '%s\n' "null"
  exit 0
fi
printf 'fake gh refusing: %s\n' "$*" >&2
exit 1
EOF
chmod +x "${sig_bin}/gh"
PATH="${sig_bin}:${PATH}" MENTIONS_TEST_BARE="$sig_bare" MENTIONS_SIG_URL="$sig_url" MENTIONS_SIG_PID="$sig_pid" MENTIONS_CONFIG="${tmp}/sig-config.json" \
  "$install" "example/mentions" --user Alice --bot my-bot --commit-name "Mentions Bot" --commit-email "bot@example.com" > "${tmp}/sig.out" 2>"${tmp}/sig.err" &
sig_install=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if [[ -s "$sig_url" && -s "$sig_pid" ]]; then
    break
  fi
  sleep 0.1
done
if [[ ! -s "$sig_url" || ! -s "$sig_pid" ]]; then
  kill -TERM "$sig_install" 2>/dev/null || true
  fail "pull request create did not start before the signal: $(cat "${tmp}/sig.err")"
fi
kill -TERM "$sig_install"
if [[ -s "$sig_pid" ]]; then
  kill -TERM "$(cat "$sig_pid")" 2>/dev/null || true
fi
set +e
wait "$sig_install"
set -e
if ! git -C "$sig_bare" show-ref --verify --quiet refs/heads/mentions/my-bot-forward; then
  fail "branch was deleted after SIGTERM: $(cat "${tmp}/sig.err")"
fi
assert_contains "${tmp}/sig.err" "kept branch mentions/my-bot-forward"

printf '%s\n' "ok"
