#!/usr/bin/env bash
# Render templates/mention-forward.yml, push a branch, and open a pull request.
# On failure, the EXIT trap deletes the remote branch (if this run pushed it)
# and removes the local temp clone. --dry-run renders and prints the plan only.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_root="$(cd "${script_dir}/.." && pwd)"
template_path="${plugin_root}/templates/mention-forward.yml"
routine_path="${plugin_root}/templates/routine-prompt.md"

repo_arg=""
trigger_user=""
bot_handle=""
comment_as=""
secret_prefix="MENTION"
branch_name=""
config_path=""
commit_name=""
commit_email=""
comments_only=0
dry_run=0
do_update=0
seen_user=0
seen_bot=0
seen_prefix=0
seen_branch=0
seen_dry=0
seen_update=0
seen_comment_as=0
seen_config=0
seen_commit_name=0
seen_commit_email=0
seen_comments_only=0
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
usage: install.sh <owner/repo> --user <login> --bot <handle> [--secret-prefix PREFIX] [--branch BRANCH] [--comment-as LOGIN] [--config PATH] [--commit-name NAME] [--commit-email EMAIL] [--comments-only] [--update] [--dry-run]
EOF
}

show_help() {
  cat <<'EOF'
usage: install.sh <owner/repo> --user <login> --bot <handle> [--secret-prefix PREFIX] [--branch BRANCH] [--comment-as LOGIN] [--config PATH] [--commit-name NAME] [--commit-email EMAIL] [--comments-only] [--update] [--dry-run]

Render the mention-forward workflow for a trigger user and bot, commit it on a
new branch, push the branch, and open a pull request. Prints the Actions
secrets to create and the Grok Bot routine prompt.

A local git path is accepted instead of owner/repo only with --dry-run. Dry-run
renders and prints the workflow, pull request text, secret routine, and handler
config without cloning, pushing, opening a pull request, or writing the config.

--user LOGIN
    GitHub login that may trigger the workflow. Outside dry-run, the login is
    replaced with the login GitHub returns for that account. Matching is
    case-insensitive. The login must differ from --bot.

--bot HANDLE
    Mention handle, with or without a leading @. Matching ignores case. The
    workflow still requires a mention boundary, so @bot does not match @bot2.

--comment-as LOGIN
    Account the handler comments and commits as. Default: the bot handle.

--secret-prefix PREFIX
    Secret names become PREFIX_WEBHOOK_URL, PREFIX_WEBHOOK_KEY, and
    PREFIX_WEBHOOK_HEADER. PREFIX matches [A-Z][A-Z0-9]{0,24}. Default: MENTION.

--branch BRANCH
    Branch to create. Default: mentions/<bot>-forward.

--config PATH
    Handler config to write or merge. Default: $MENTIONS_CONFIG, or
    ~/.config/mentions/config.json. Dry-run prints the document and does not
    write it.

--commit-name NAME
    git user.name the bot uses for commits. Required on a real install unless
    --comments-only is set.

--commit-email EMAIL
    git user.email the bot uses for commits. Required with --commit-name.

--comments-only
    Write an empty commit identity. The handler comments and does not commit.

--update
    When the workflow file already exists on the default branch, open a pull
    request that replaces it. Without this flag, an existing file is an error.

--dry-run
    Print the plan only.

The machine running this script needs its own git user.name and user.email.
Those values commit the workflow. They are not written into the handler config.

After a push, the script asks GitHub whether a pull request for the branch
exists. It deletes the branch only when that query succeeds and no pull request
is there. If the query fails, the branch is kept. This script does not embed
tokens. The setup credential needs Contents write, Pull requests write,
Workflows write, and Secrets write on the repository. The push preflight
sees repository push access only. It does not prove those fine-grained
scopes. The runtime bot token does not get Workflows or Secrets write.

commit_comment is not an Actions trigger. actionlint rejects a workflow that
subscribes to it.

Examples:
  install.sh owner/repo --user octocat --bot my-bot
  install.sh owner/repo --user octocat --bot my-bot --secret-prefix CUSTOM --dry-run
  install.sh owner/repo --user octocat --bot my-bot --update
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

confirm_pull_request() {
  local found list_status
  if [[ -z "${repo_arg:-}" || -z "${branch_name:-}" ]]; then
    return 2
  fi
  set +e
  found="$(gh pr list --repo "$repo_arg" --head "$branch_name" --state all --json url --jq '.[0].url' 2>/dev/null | tr -d '[:space:]')"
  list_status=$?
  set -e
  if [[ "$list_status" -ne 0 ]]; then
    return 2
  fi
  if [[ -n "$found" && "$found" != "null" ]]; then
    printf '%s\n' "$found"
    return 0
  fi
  return 1
}

cleanup() {
  local ec=$?
  local found query
  if [[ "$ec" -ne 0 && "$did_push" -eq 1 ]]; then
    set +e
    found="$(confirm_pull_request)"
    query=$?
    set -e
    if [[ "$query" -eq 0 ]]; then
      printf 'pull request exists: %s\n' "$found" >&2
      printf 'kept branch %s\n' "$branch_name" >&2
      did_push=0
    elif [[ "$query" -ne 1 ]]; then
      printf 'could not confirm whether a pull request exists; kept branch %s\n' "$branch_name" >&2
      did_push=0
    fi
  fi
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

fold_login() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
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
      --comment-as)
        [[ "$seen_comment_as" -eq 0 ]] || die "duplicate --comment-as"
        seen_comment_as=1
        require_value "--comment-as" "${2-}"
        comment_as="$2"
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
      --config)
        [[ "$seen_config" -eq 0 ]] || die "duplicate --config"
        seen_config=1
        require_value "--config" "${2-}"
        config_path="$2"
        shift 2
        ;;
      --update)
        [[ "$seen_update" -eq 0 ]] || die "duplicate --update"
        seen_update=1
        do_update=1
        shift
        ;;
      --commit-name)
        [[ "$seen_commit_name" -eq 0 ]] || die "duplicate --commit-name"
        seen_commit_name=1
        require_value "--commit-name" "${2-}"
        commit_name="$2"
        shift 2
        ;;
      --commit-email)
        [[ "$seen_commit_email" -eq 0 ]] || die "duplicate --commit-email"
        seen_commit_email=1
        require_value "--commit-email" "${2-}"
        commit_email="$2"
        shift 2
        ;;
      --comments-only)
        [[ "$seen_comments_only" -eq 0 ]] || die "duplicate --comments-only"
        seen_comments_only=1
        comments_only=1
        shift
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
  [[ -f "$routine_path" ]] || die "missing routine prompt: ${routine_path}"
  [[ "$seen_user" -eq 1 ]] || die "--user is required"
  [[ "$seen_bot" -eq 1 ]] || die "--bot is required"
  if [[ "$bot_handle" == @* ]]; then
    bot_handle="${bot_handle#@}"
  fi
  if [[ "$comment_as" == @* ]]; then
    comment_as="${comment_as#@}"
  fi
  if ! valid_login "$trigger_user"; then
    die "invalid --user login: ${trigger_user}"
  fi
  if ! valid_login "$bot_handle"; then
    die "invalid --bot handle: ${bot_handle}"
  fi
  if [[ -z "$comment_as" ]]; then
    comment_as="$bot_handle"
  fi
  if ! valid_login "$comment_as"; then
    die "invalid --comment-as login: ${comment_as}"
  fi
  if [[ "$(fold_login "$trigger_user")" == "$(fold_login "$bot_handle")" ]]; then
    die "--user and --bot must be different accounts"
  fi
  if ! valid_prefix "$secret_prefix"; then
    die "invalid --secret-prefix: ${secret_prefix} (use [A-Z][A-Z0-9]{0,24}, for example MENTION)"
  fi
  if [[ "$comments_only" -eq 1 ]]; then
    if [[ "$seen_commit_name" -eq 1 || "$seen_commit_email" -eq 1 ]]; then
      die "--comments-only does not take --commit-name or --commit-email"
    fi
    commit_name=""
    commit_email=""
  elif [[ "$dry_run" -eq 0 ]]; then
    if [[ -z "$commit_name" || -z "$commit_email" ]]; then
      die "--commit-name and --commit-email are required unless --comments-only"
    fi
    if [[ "$commit_email" != *@* ]]; then
      die "invalid --commit-email"
    fi
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
  if [[ -z "$config_path" ]]; then
    config_path="${MENTIONS_CONFIG:-${HOME}/.config/mentions/config.json}"
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

print_config() {
  local repo_json="[]"
  if [[ "$target_kind" == "github" ]]; then
    repo_json="[\"${repo_arg}\"]"
  fi
  cat <<EOF
config_path: ${config_path}
config:
{
  "trigger_user": "${trigger_user}",
  "bot_handle": "${bot_handle}",
  "repos": ${repo_json},
  "comment_as": "${comment_as}",
  "gh_token_env": "GH_TOKEN",
  "state_dir": "${HOME}/.local/state/mentions",
  "work_root": "${HOME}/.local/share/mentions/work",
  "commit_name": "${commit_name}",
  "commit_email": "${commit_email}"
}
EOF
}

instructions() {
  cat <<EOF
GitHub Actions secrets on ${repo_arg}:

- ${secret_url} receives the routine webhook URL.
- ${secret_header} receives the full Authorization line from the Grok Bot routine panel, including the Authorization prefix. This is the default.
- ${secret_key} is only for the alternative where ${secret_header} is a bare header name. Leave ${secret_key} unset when ${secret_header} is the full line.

Grok Bot routine:

1. Install this plugin.
2. Create a routine with a webhook trigger.
3. Copy the webhook URL and the full Authorization line.
4. Set the secrets. Inside Grok Bot, use a secret card. The bot reads WEBHOOK_URL, WEBHOOK_HEADER, and, only for a bare header name, WEBHOOK_KEY. Otherwise a person runs gh secret set.
5. Paste the routine prompt below into the routine.
6. After this pull request is merged, run the three-case smoke test. A mention from the trigger user is delivered. A mention from the bot is skipped. A trigger-user comment without the mention is skipped.

Set secrets without printing the values:

printf '%s' "\$WEBHOOK_URL" | gh secret set ${secret_url} -R ${repo_arg}
printf '%s' "\$WEBHOOK_HEADER" | gh secret set ${secret_header} -R ${repo_arg}

Merge the workflow pull request onto the default branch after the secrets exist. Issue, comment, and discussion events run this file only from the default branch.

The workflow covers issues, issue comments, pull requests, pull request reviews, pull request review comments, discussions, and discussion comments. Text events include edits. Deletes are not forwarded. Pull request opened and edited events use pull_request_target so secrets come from the default branch. The job does not check out repository code. Fork pull request reviews and review comments have no secrets, so the job exits 0 with a notice instead of failing. commit_comment is not an Actions trigger. actionlint rejects a workflow that subscribes to it.

Routine prompt:

EOF
  cat "$routine_path"
  printf '\n%s\n' "Handler config:"
  print_config
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
comment_as: ${comment_as}
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

A scheduled \`sweep\` job forwards reviews and inline review comments that got no run of their own. GitHub creates no review run while a pull request has a merge conflict. The sweep runs six times an hour. On a private repository each run bills Actions minutes.

\`commit_comment\` is not an Actions trigger. actionlint rejects a workflow that subscribes to it.

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

write_workflow() {
  local dest_dir="$1"
  local dest tmp
  dest="${dest_dir}/mention-forward.yml"
  mkdir -p "$dest_dir"
  if [[ -e "$dest" && "$do_update" -eq 0 ]]; then
    die "workflow already exists: .github/workflows/mention-forward.yml (re-run with --update)"
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

canonical_user() {
  local resolved
  if ! resolved="$(gh api "users/${trigger_user}" --jq .login)"; then
    die "could not look up --user ${trigger_user}"
  fi
  if ! valid_login "$resolved"; then
    die "GitHub returned an invalid login for --user"
  fi
  trigger_user="$resolved"
  if [[ "$(fold_login "$trigger_user")" == "$(fold_login "$bot_handle")" ]]; then
    die "--user and --bot must be different accounts"
  fi
}

merge_config() {
  local dir tmp
  if [[ "$target_kind" != "github" ]]; then
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    die "jq is required to write ${config_path}"
  fi
  dir="$(dirname "$config_path")"
  mkdir -p "$dir"
  tmp="$(mktemp "${dir}/.config.XXXXXXXX")"
  if [[ -f "$config_path" ]]; then
    if ! jq --arg repo "$repo_arg" \
      --arg trigger_user "$trigger_user" \
      --arg bot_handle "$bot_handle" \
      --arg comment_as "$comment_as" \
      --arg commit_name "$commit_name" \
      --arg commit_email "$commit_email" \
      '
        .trigger_user = $trigger_user
        | .bot_handle = $bot_handle
        | .comment_as = $comment_as
        | .gh_token_env = (.gh_token_env // "GH_TOKEN")
        | .state_dir = (.state_dir // (env.HOME + "/.local/state/mentions"))
        | .work_root = (.work_root // (env.HOME + "/.local/share/mentions/work"))
        | .commit_name = $commit_name
        | .commit_email = $commit_email
        | .repos = ((.repos // []) + [$repo] | unique)
      ' "$config_path" > "$tmp"; then
      rm -f "$tmp"
      die "could not merge ${config_path}"
    fi
  else
    if ! jq -n \
      --arg repo "$repo_arg" \
      --arg trigger_user "$trigger_user" \
      --arg bot_handle "$bot_handle" \
      --arg comment_as "$comment_as" \
      --arg state_dir "${HOME}/.local/state/mentions" \
      --arg work_root "${HOME}/.local/share/mentions/work" \
      --arg commit_name "$commit_name" \
      --arg commit_email "$commit_email" \
      '{
        trigger_user: $trigger_user,
        bot_handle: $bot_handle,
        repos: [$repo],
        comment_as: $comment_as,
        gh_token_env: "GH_TOKEN",
        state_dir: $state_dir,
        work_root: $work_root,
        commit_name: $commit_name,
        commit_email: $commit_email
      }' > "$tmp"; then
      rm -f "$tmp"
      die "could not write ${config_path}"
    fi
  fi
  mv -f "$tmp" "$config_path"
}

run_install() {
  local base_branch pr_url body_file pr_title pr_status found list_status perm
  export GIT_TERMINAL_PROMPT=0
  export GH_PROMPT_DISABLED=1
  if ! command -v gh >/dev/null 2>&1; then
    die "gh is required to clone the repository and open the pull request"
  fi
  if ! gh auth status >/dev/null; then
    die "gh is not authenticated; run gh auth login before installing"
  fi
  canonical_user
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
  if [[ -e "${clone_dir}/.github/workflows/mention-forward.yml" && "$do_update" -eq 0 ]]; then
    die "workflow already exists: .github/workflows/mention-forward.yml (re-run with --update)"
  fi
  perm="$(gh api "repos/${repo_arg}")" || die "could not read repository permissions for ${repo_arg}"
  if printf '%s' "$perm" | jq -e '.permissions.pull_requests == false or .permissions.pull_requests == "read"' >/dev/null; then
    die "setup credential cannot open a pull request on ${repo_arg}. It needs Pull requests write, plus Contents write, Workflows write, and Secrets write. The push preflight does not prove those scopes. The runtime bot token does not get Workflows or Secrets."
  fi
  if ! printf '%s' "$perm" | jq -e '(.permissions.push == true or .permissions.admin == true or .permissions.maintain == true)' >/dev/null; then
    die "setup credential cannot push to ${repo_arg}. It needs Contents write, Pull requests write, Workflows write, and Secrets write. This preflight sees repository push access only. The runtime bot token does not get Workflows or Secrets."
  fi
  git -C "$clone_dir" checkout -q -b "$branch_name"
  write_workflow "${clone_dir}/.github/workflows"
  git -C "$clone_dir" add -- .github/workflows/mention-forward.yml
  git -C "$clone_dir" commit -q \
    -m "Add mention-forward workflow for @${bot_handle}" \
    -m "Forward mentions from ${trigger_user} to the webhook without checking out repository code."
  git -C "$clone_dir" push --quiet origin "HEAD:refs/heads/${branch_name}"
  did_push=1
  body_file="${tmp_root}/pr-body.md"
  write_pr_body "$body_file"
  pr_title="Forward @${bot_handle} mentions from ${trigger_user}"
  set +e
  pr_url="$(gh pr create --repo "$repo_arg" --base "$base_branch" --head "$branch_name" --title "$pr_title" --body-file "$body_file" 2>"${tmp_root}/pr-create.err")"
  pr_status=$?
  set -e
  if [[ "$pr_status" -ne 0 ]]; then
    printf 'pr create failed; checking for an existing pull request\n' >&2
    set +e
    found="$(confirm_pull_request)"
    list_status=$?
    set -e
    if [[ "$list_status" -eq 0 ]]; then
      did_push=0
      pr_url="$found"
      printf 'pull request exists: %s\n' "$pr_url" >&2
      printf 'kept branch %s\n' "$branch_name" >&2
    elif [[ "$list_status" -eq 1 ]]; then
      printf 'no pull request for %s\n' "$branch_name" >&2
      die "pull request was not created"
    else
      did_push=0
      printf 'could not confirm whether a pull request exists; kept branch %s\n' "$branch_name" >&2
      die "pull request status is unknown"
    fi
  else
    did_push=0
  fi
  if ! merge_config; then
    die "pull request is open but the handler config was not written: ${pr_url}"
  fi
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
