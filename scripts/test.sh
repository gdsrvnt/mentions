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

if ! command -v actionlint >/dev/null 2>&1; then
  fail "actionlint is required"
fi
if ! command -v git >/dev/null 2>&1; then
  fail "git is required"
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
assert_contains "$dry_out" "secret_url: GROKBOT_WEBHOOK_URL"
assert_contains "$dry_out" "secret_key: GROKBOT_WEBHOOK_KEY"
assert_contains "$dry_out" "secret_header: GROKBOT_WEBHOOK_HEADER"
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
assert_contains "$wf" "secrets.GROKBOT_WEBHOOK_URL"
assert_contains "$wf" "secrets.GROKBOT_WEBHOOK_KEY"
assert_contains "$wf" "secrets.GROKBOT_WEBHOOK_HEADER"
assert_contains "$wf" "pull_request_target:"
assert_contains "$wf" "issue_comment:"
assert_contains "$wf" "pull_request_review:"
assert_contains "$wf" "pull_request_review_comment:"
assert_contains "$wf" "discussion:"
assert_contains "$wf" "discussion_comment:"
assert_contains "$wf" "issues:"
assert_contains "$wf" "commit_comment cannot be supported reliably"
assert_contains "$wf" "pull_request"
assert_contains "$wf" "{event_name: \$event_name, payload: \$payload[0]}"
assert_not_contains "$wf" "actions/checkout"
assert_not_contains "$wf" "__MENTIONS_"
assert_not_contains "$wf" "GoddyB"
assert_not_contains "$wf" "ArchAgents"
assert_not_contains "$wf" "sparks"
assert_not_contains "$wf" "gdsrvnt"

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
expect_fail "$install" "$bare" --user Alice --user Bob --bot my-bot --dry-run
expect_fail "$install" "$bare" --user Alice --bot my-bot --nope
expect_fail "$install" "$bare" --dry-run
expect_fail "$install" "$tmp" --user Alice --bot my-bot
help_out="${tmp}/help.out"
"$install" --help > "$help_out"
assert_contains "$help_out" "--dry-run"
assert_contains "$help_out" "--secret-prefix"
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
if [[ "${1:-}" == "repo" && "${2:-}" == "clone" ]]; then
  dest="${4:?dest}"
  git clone --quiet "${MENTIONS_TEST_BARE:?}" "$dest"
  exit 0
fi
printf 'fake gh refusing: %s\n' "$*" >&2
exit 1
EOF
chmod +x "${fakebin}/gh"
set +e
PATH="${fakebin}:${PATH}" MENTIONS_TEST_BARE="$bare" "$install" "example/mentions" --user Alice --bot my-bot > "$rollback_out" 2>"$rollback_err"
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
assert_contains "$rollback_err" "fake gh refusing: pr create"
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

if grep -R -n -E --exclude 'test.sh' 'GoddyB|gdsrvnt|sparks' \
  "${root}/scripts" "${root}/skills" "${root}/templates" "${root}/README.md" \
  "${root}/.github" "${root}/.cursor-plugin" "${root}/CHANGELOG.md"; then
  fail "found source-specific product names"
fi
if grep -n -E 'git config (--global|--system)' "$install"; then
  fail "install.sh changes git config"
fi

printf '%s\n' "ok"
