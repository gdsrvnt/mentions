#!/usr/bin/env bash
# Render templates/mention-forward.yml, push a branch, and open a pull request.
# On failure, the EXIT trap deletes the remote branch (if this run pushed it)
# and removes the local temp clone. --dry-run renders and prints the plan only.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_root="$(cd "${script_dir}/.." && pwd)"
template_path="${plugin_root}/templates/mention-forward.yml"

repo_arg=""
trigger_user=""
bot_handle=""
secret_prefix="GROKBOT"
branch_name=""
dry_run=0
seen_user=0
seen_bot=0
seen_prefix=0
seen_branch=0
seen_dry=0
target_kind=""
secret_url=""
secret_key=""
secret_header=""

dry_rendered=""
tmp_root=""
clone_dir=""
did_push=0

usage() {
  cat >&2 <<'EOF'
usage: install.sh <owner/repo> --user <login> --bot <handle> [--secret-prefix PREFIX] [--branch BRANCH] [--dry-run]
EOF
}

show_help() {
  cat <<'EOF'
usage: install.sh <owner/repo> --user <login> --bot <handle> [--secret-prefix PREFIX] [--branch BRANCH] [--dry-run]

Render the mention-forward workflow for a trigger user and bot, commit it on a
new branch, push the branch, and open a pull request. Prints the Actions
secrets to create and the webhook routine that should receive
{"event_name","payload"}.

A local git path is accepted instead of owner/repo only with --dry-run. Dry-run
renders and prints the workflow, pull request text, and secret routine without
cloning, pushing, or opening a pull request.

--secret-prefix PREFIX
    Secret names become PREFIX_WEBHOOK_URL, PREFIX_WEBHOOK_KEY, and
    PREFIX_WEBHOOK_HEADER. PREFIX matches [A-Z][A-Z0-9]{0,24}. Default: GROKBOT,
    which selects GROKBOT_WEBHOOK_URL, GROKBOT_WEBHOOK_KEY, and
    GROKBOT_WEBHOOK_HEADER.

--branch BRANCH
    Branch to create. Default: mentions/<bot>-forward.

--bot HANDLE
    Mention handle, with or without a leading @. The match is case-sensitive.

On any failure after a push, the script deletes that remote branch and its
temporary clone. Commits use the existing git user.name and user.email. This
script does not embed tokens.

commit_comment cannot be supported reliably because GitHub Actions has no
commit_comment trigger.

Examples:
  install.sh owner/repo --user octocat --bot my-bot
  install.sh owner/repo --user octocat --bot my-bot --secret-prefix CUSTOM --dry-run
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local ec=$?
  if [[ "$ec" -ne 0 && "$did_push" -eq 1 && -n "$clone_dir" && -d "$clone_dir" ]]; then
    printf 'rollback: deleting remote branch %s\n' "$branch_name" >&2
    if ! git -C "$clone_dir" push --quiet origin ":refs/heads/${branch_name}"; then
      printf 'rollback: failed to delete remote branch %s\n' "$branch_name" >&2
    fi
    did_push=0
  fi
  if [[ -n "$dry_rendered" && -f "$dry_rendered" ]]; then
    rm -f "$dry_rendered" || printf 'rollback: failed to remove %s\n' "$dry_rendered" >&2
    dry_rendered=""
  fi
  if [[ -n "$tmp_root" && -d "$tmp_root" ]]; then
    if [[ "$ec" -ne 0 ]]; then
      printf 'rollback: removing temp clone %s\n' "$tmp_root" >&2
    fi
    rm -rf "$tmp_root" || printf 'rollback: failed to remove temp clone %s\n' "$tmp_root" >&2
    tmp_root=""
    clone_dir=""
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

valid_owner_repo() {
  local spec="$1"
  local owner name
  local owner_repo_re='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
  if [[ ! "$spec" =~ $owner_repo_re ]]; then
    return 1
  fi
  owner="${spec%%/*}"
  name="${spec#*/}"
  if [[ "$owner" == "." || "$owner" == ".." || "$name" == "." || "$name" == ".." ]]; then
    return 1
  fi
  if [[ "$owner" == .* || "$name" == .* ]]; then
    return 1
  fi
  if [[ "$owner" == *.git || "$name" == *.git ]]; then
    return 1
  fi
  if [[ ${#owner} -gt 100 || ${#name} -gt 100 ]]; then
    return 1
  fi
  return 0
}

valid_login() {
  local value="$1"
  local login_re='^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'
  [[ "$value" =~ $login_re ]]
}

valid_prefix() {
  local value="$1"
  local prefix_re='^[A-Z][A-Z0-9]{0,24}$'
  [[ "$value" =~ $prefix_re ]]
}

valid_branch() {
  local value="$1"
  local normalized=""
  if [[ -z "$value" || "$value" == *" "* || "$value" == *$'\t'* || "$value" == *$'\n'* ]]; then
    return 1
  fi
  if ! normalized="$(git check-ref-format --branch "$value" 2>/dev/null)"; then
    return 1
  fi
  [[ "$normalized" == "$value" ]]
}

require_value() {
  local flag="$1"
  local value="${2-}"
  if [[ -z "$value" || "$value" == -* ]]; then
    die "${flag} requires a value"
  fi
}

parse_args() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 2
  fi
  if [[ "$1" == -* ]]; then
    usage
    die "first argument must be <owner/repo> or a local git path"
  fi
  repo_arg="$1"
  shift

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --user)
        [[ "$seen_user" -eq 0 ]] || die "duplicate --user"
        seen_user=1
        require_value "--user" "${2-}"
        trigger_user="$2"
        shift 2
        ;;
      --bot)
        [[ "$seen_bot" -eq 0 ]] || die "duplicate --bot"
        seen_bot=1
        require_value "--bot" "${2-}"
        bot_handle="$2"
        shift 2
        ;;
      --secret-prefix)
        [[ "$seen_prefix" -eq 0 ]] || die "duplicate --secret-prefix"
        seen_prefix=1
        require_value "--secret-prefix" "${2-}"
        secret_prefix="$2"
        shift 2
        ;;
      --branch)
        [[ "$seen_branch" -eq 0 ]] || die "duplicate --branch"
        seen_branch=1
        require_value "--branch" "${2-}"
        branch_name="$2"
        shift 2
        ;;
      --dry-run)
        [[ "$seen_dry" -eq 0 ]] || die "duplicate --dry-run"
        seen_dry=1
        dry_run=1
        shift
        ;;
      --)
        shift
        if [[ $# -gt 0 ]]; then
          die "unexpected argument: $1"
        fi
        break
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done
}

classify_target() {
  if [[ -e "$repo_arg" ]]; then
    target_kind="local"
    if ! git -C "$repo_arg" rev-parse --git-dir >/dev/null 2>&1; then
      die "not a git repository: ${repo_arg}"
    fi
    return 0
  fi
  target_kind="github"
  if ! valid_owner_repo "$repo_arg"; then
    die "invalid owner/repo: ${repo_arg}"
  fi
}

validate_all() {
  if ! command -v git >/dev/null 2>&1; then
    die "git is required"
  fi
  [[ -f "$template_path" ]] || die "missing template: ${template_path}"
  [[ "$seen_user" -eq 1 ]] || die "--user is required"
  [[ "$seen_bot" -eq 1 ]] || die "--bot is required"
  if [[ "$bot_handle" == @* ]]; then
    bot_handle="${bot_handle#@}"
  fi
  if ! valid_login "$trigger_user"; then
    die "invalid --user login: ${trigger_user}"
  fi
  if ! valid_login "$bot_handle"; then
    die "invalid --bot handle: ${bot_handle}"
  fi
  if ! valid_prefix "$secret_prefix"; then
    die "invalid --secret-prefix: ${secret_prefix} (use [A-Z][A-Z0-9]{0,24}, for example GROKBOT)"
  fi
  secret_url="${secret_prefix}_WEBHOOK_URL"
  secret_key="${secret_prefix}_WEBHOOK_KEY"
  secret_header="${secret_prefix}_WEBHOOK_HEADER"
  if [[ -z "$branch_name" ]]; then
    branch_name="mentions/${bot_handle}-forward"
  fi
  if ! valid_branch "$branch_name"; then
    die "invalid --branch name: ${branch_name}"
  fi
  classify_target
  if [[ "$dry_run" -eq 0 && "$target_kind" != "github" ]]; then
    die "a local git path supports only --dry-run; pass owner/repo to open a pull request"
  fi
}

render_workflow() {
  local dest="$1"
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line//__MENTIONS_TRIGGER_USER__/${trigger_user}}"
    line="${line//__MENTIONS_BOT_HANDLE__/${bot_handle}}"
    line="${line//__MENTIONS_SECRET_URL__/${secret_url}}"
    line="${line//__MENTIONS_SECRET_KEY__/${secret_key}}"
    line="${line//__MENTIONS_SECRET_HEADER__/${secret_header}}"
    printf '%s\n' "$line"
  done < "$template_path" > "$dest"
}

assert_rendered() {
  local dest="$1"
  if [[ ! -s "$dest" ]]; then
    die "rendered workflow is empty"
  fi
  if grep -q '__MENTIONS_' "$dest"; then
    die "internal error: unsubstituted placeholder in rendered workflow"
  fi
}

instructions() {
  cat <<EOF
Create these GitHub Actions secrets on ${repo_arg}:

- ${secret_url}: HTTPS endpoint of the webhook routine
- ${secret_key}: shared secret sent in the webhook header
- ${secret_header}: header name that carries the key (for example, X-Webhook-Key)

Webhook routine:

1. Accept POST requests only.
2. Compare the header named by the ${secret_header} secret with the value of ${secret_key}. Reject mismatches with HTTP 401.
3. Parse a JSON object with two fields: event_name (string) and payload (the GitHub event object).
4. Invoke the handle-mention skill with that object. The skill re-checks the sender, repository, and mention before it replies.
5. Merge the workflow pull request onto the default branch. Issue, comment, and discussion events run this file only from the default branch.

The workflow covers issues, issue comments, pull requests, pull request reviews, pull request review comments, discussions, and discussion comments. Pull request opened and edited events use pull_request_target so secrets come from the default branch. The job does not check out repository code. commit_comment cannot be supported reliably because GitHub Actions has no commit_comment trigger.

Configure handle-mention with trigger user ${trigger_user}, bot handle ${bot_handle}, and repository ${repo_arg}.
EOF
}

print_plan() {
  local mode_label="install"
  if [[ "$dry_run" -eq 1 ]]; then
    mode_label="dry-run"
  fi
  cat <<EOF
mode: ${mode_label}
repository: ${repo_arg}
trigger_user: ${trigger_user}
bot_handle: ${bot_handle}
mention: @${bot_handle}
secret_url: ${secret_url}
secret_key: ${secret_key}
secret_header: ${secret_header}
branch: ${branch_name}
workflow_path: .github/workflows/mention-forward.yml
workflow_name: mention-forward
commit_subject: Add mention-forward workflow for @${bot_handle}
EOF
}

print_secrets() {
  printf '%s\n' "===== SECRETS AND WEBHOOK ====="
  instructions
  printf '%s\n' "===== END SECRETS AND WEBHOOK ====="
}

print_pr_body() {
  cat <<EOF
## Summary

Adds \`.github/workflows/mention-forward.yml\` to forward GitHub mentions of \`@${bot_handle}\` made by \`${trigger_user}\`.

The workflow posts \`{"event_name","payload"}\` to the webhook. It does not check out repository code. Pull request opened and edited events use \`pull_request_target\` so secrets come from the default branch.

\`commit_comment\` cannot be supported reliably because GitHub Actions has no \`commit_comment\` trigger.

## Secrets and webhook

EOF
  instructions
}

write_pr_body() {
  local dest="$1"
  print_pr_body > "$dest"
}

run_dry() {
  dry_rendered="$(mktemp "${TMPDIR:-/tmp}/mention-forward.XXXXXXXX")"
  render_workflow "$dry_rendered"
  assert_rendered "$dry_rendered"
  print_plan
  printf '%s\n' "===== RENDERED WORKFLOW ====="
  cat "$dry_rendered"
  printf '%s\n' "===== END RENDERED WORKFLOW ====="
  printf '%s\n' "===== PULL REQUEST BODY ====="
  print_pr_body
  printf '%s\n' "===== END PULL REQUEST BODY ====="
  print_secrets
  printf '%s\n' "dry-run: no network writes"
}

detect_default_branch() {
  local clone="$1"
  local ref=""
  if ref="$(git -C "$clone" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"; then
    printf '%s\n' "${ref#origin/}"
    return 0
  fi
  if git -C "$clone" show-ref --verify --quiet refs/remotes/origin/main; then
    printf '%s\n' "main"
    return 0
  fi
  if git -C "$clone" show-ref --verify --quiet refs/remotes/origin/master; then
    printf '%s\n' "master"
    return 0
  fi
  return 1
}

atomic_install_workflow() {
  local dest_dir="$1"
  local dest tmp
  dest="${dest_dir}/mention-forward.yml"
  mkdir -p "$dest_dir"
  if [[ -e "$dest" ]]; then
    die "workflow already exists: .github/workflows/mention-forward.yml"
  fi
  tmp="$(mktemp "${dest_dir}/.mention-forward.yml.XXXXXXXX")"
  if ! render_workflow "$tmp"; then
    rm -f "$tmp"
    die "failed to render workflow"
  fi
  if ! assert_rendered "$tmp"; then
    rm -f "$tmp"
    die "rendered workflow failed validation"
  fi
  mv -f "$tmp" "$dest"
}

run_install() {
  local base_branch pr_url body_file pr_title
  export GIT_TERMINAL_PROMPT=0
  export GH_PROMPT_DISABLED=1
  if ! command -v gh >/dev/null 2>&1; then
    die "gh is required to clone the repository and open the pull request"
  fi
  if ! gh auth status >/dev/null; then
    die "gh is not authenticated; run gh auth login before installing"
  fi
  tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/mentions-install.XXXXXXXX")"
  clone_dir="${tmp_root}/repo"
  printf 'temp-clone: %s\n' "$tmp_root" >&2
  if ! gh repo clone "$repo_arg" "$clone_dir" -- --quiet; then
    die "failed to clone ${repo_arg}"
  fi
  if ! git -C "$clone_dir" config --get user.name >/dev/null; then
    die "git user.name must be set before installing"
  fi
  if ! git -C "$clone_dir" config --get user.email >/dev/null; then
    die "git user.email must be set before installing"
  fi
  if ! base_branch="$(detect_default_branch "$clone_dir")"; then
    die "could not determine the default branch"
  fi
  if git -C "$clone_dir" ls-remote --exit-code --heads origin "$branch_name" >/dev/null 2>&1; then
    die "remote branch already exists: ${branch_name}"
  fi
  if [[ -e "${clone_dir}/.github/workflows/mention-forward.yml" ]]; then
    die "workflow already exists: .github/workflows/mention-forward.yml"
  fi
  git -C "$clone_dir" checkout -q -b "$branch_name"
  atomic_install_workflow "${clone_dir}/.github/workflows"
  git -C "$clone_dir" add -- .github/workflows/mention-forward.yml
  git -C "$clone_dir" commit -q \
    -m "Add mention-forward workflow for @${bot_handle}" \
    -m "Forward mentions from ${trigger_user} to the webhook without checking out repository code."
  git -C "$clone_dir" push --quiet origin "HEAD:refs/heads/${branch_name}"
  did_push=1
  body_file="${tmp_root}/pr-body.md"
  write_pr_body "$body_file"
  pr_title="Forward @${bot_handle} mentions from ${trigger_user}"
  pr_url="$(gh pr create --repo "$repo_arg" --base "$base_branch" --head "$branch_name" --title "$pr_title" --body-file "$body_file")"
  print_plan
  printf 'base: %s\n' "$base_branch"
  printf 'pull_request: %s\n' "$pr_url"
  print_secrets
}

main() {
  local arg
  if [[ $# -eq 0 ]]; then
    usage
    exit 2
  fi
  for arg in "$@"; do
    if [[ "$arg" == "-h" || "$arg" == "--help" ]]; then
      show_help
      exit 0
    fi
  done
  parse_args "$@"
  validate_all
  if [[ "$dry_run" -eq 1 ]]; then
    run_dry
    return 0
  fi
  run_install
}

main "$@"
