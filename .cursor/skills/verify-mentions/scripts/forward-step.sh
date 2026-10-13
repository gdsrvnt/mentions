#!/usr/bin/env bash
# Run the rendered workflow's "Forward event to webhook" step the way an Actions
# runner does (bash -eo pipefail, the step's env), against webhook-capture.py on
# 127.0.0.1. Run it through `control-mentions drive` so it lands in step evidence.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat >&2 <<'EOF'
usage: forward-step.sh --workflow FILE --event NAME --payload FILE
                       [--header VALUE] [--key VALUE] [--no-url]
                       [--require-header 'Name: value'] [--out-dir DIR]

  --workflow        rendered mention-forward.yml (from install.sh --dry-run)
  --event           value for github.event_name (EVENT_NAME)
  --payload         event JSON file (GITHUB_EVENT_PATH); a bare name is looked up in $VM_FIXTURES
  --header          *_WEBHOOK_HEADER secret value: a header name or a full "Name: value" line
  --key             *_WEBHOOK_KEY secret value
  --no-url          leave *_WEBHOOK_URL unset (the step must fail with ::error::)
  --require-header  header line the stand-in routine accepts; others get 401
  --out-dir         where step.sh and requests.jsonl go (default: $VM_STEP)

Example:
  forward-step.sh --workflow "$VM_STATE/mention-forward.yml" --event issue_comment \
    --payload issue_comment-pr-mention.json \
    --header X-Webhook-Key --key test-key-123 --require-header 'X-Webhook-Key: test-key-123'
EOF
}

workflow="" event="" payload="" header="" key="" no_url=0 require="" out_dir="${VM_STEP:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workflow) workflow="$2"; shift 2 ;;
    --event) event="$2"; shift 2 ;;
    --payload) payload="$2"; shift 2 ;;
    --header) header="$2"; shift 2 ;;
    --key) key="$2"; shift 2 ;;
    --no-url) no_url=1; shift ;;
    --require-header) require="$2"; shift 2 ;;
    --out-dir) out_dir="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; printf 'error: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
if [[ ! -f "$payload" && "$payload" != */* && -f "${VM_FIXTURES:-/nonexistent}/${payload}" ]]; then
  payload="${VM_FIXTURES}/${payload}"
fi
[[ -f "$workflow" && -n "$event" && -f "$payload" && -n "$out_dir" ]] || { usage; exit 2; }
mkdir -p "$out_dir"

step="${out_dir}/step.sh"
awk '
  /^[[:space:]]*- name: Forward event to webhook[[:space:]]*$/ { in_step = 1; next }
  in_step && /^[[:space:]]*run: [|]/ { in_run = 1; match($0, /^ */); base = RLENGTH; next }
  in_run {
    if ($0 ~ /^[[:space:]]*$/) { print ""; next }
    match($0, /^ */)
    if (RLENGTH <= base) exit
    if (!indent) indent = RLENGTH
    print substr($0, indent + 1)
  }
' "$workflow" > "$step"
[[ -s "$step" ]] || { printf 'error: no "Forward event to webhook" run block in %s\n' "$workflow" >&2; exit 2; }
printf 'forward-step: extracted %s lines into %s\n' "$(wc -l < "$step")" "$step"

requests="${out_dir}/requests.jsonl"
port_file="${out_dir}/webhook.port"
: > "$requests"
rm -f "$port_file"
server_args=(--port-file "$port_file" --out "$requests")
[[ -n "$require" ]] && server_args+=(--require-header "$require")
python3 -I "${here}/webhook-capture.py" "${server_args[@]}" 2>"${out_dir}/webhook-server.log" &
server_pid=$!
pid_file="${VM_PIDS:+${VM_PIDS}/webhook-capture-${server_pid}.pid}"
[[ -n "$pid_file" ]] && printf '%s\n' "$server_pid" > "$pid_file"
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; [[ -z "$pid_file" ]] || rm -f "$pid_file"' EXIT
for _ in $(seq 1 50); do [[ -s "$port_file" ]] && break; sleep 0.1; done
[[ -s "$port_file" ]] || { printf 'error: webhook-capture did not start; see %s\n' "${out_dir}/webhook-server.log" >&2; exit 1; }
port="$(cat "$port_file")"
printf 'forward-step: stand-in routine on 127.0.0.1:%s (require: %s)\n' "$port" "${require:-none}"

runner_temp="$(mktemp -d "${TMPDIR:-/tmp}/runner-temp.XXXXXX")"
url="http://127.0.0.1:${port}/hooks/mention"
[[ "$no_url" -eq 1 ]] && url=""
set +e
env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
  EVENT_NAME="$event" WEBHOOK_URL="$url" WEBHOOK_KEY="$key" WEBHOOK_HEADER="$header" \
  GITHUB_EVENT_PATH="$payload" RUNNER_TEMP="$runner_temp" \
  bash --noprofile --norc -eo pipefail "$step"
status=$?
set -e
rm -rf "$runner_temp"
printf '\nforward-step: step exit %s; %s request(s) captured in %s\n' "$status" "$(wc -l < "$requests")" "$requests"
exit "$status"
