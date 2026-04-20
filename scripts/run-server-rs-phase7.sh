#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_RS_DIR="$ROOT_DIR/server-rs"
ROUTES_RS_PATH="$ROOT_DIR/server-rs/src/http/routes.rs"

DATABASE_URL_DEFAULT="postgresql://postgres:postgres@localhost:5432/jiuzhou"
REDIS_URL_DEFAULT="redis://127.0.0.1:6379"

DRY_RUN=false
PHASE7_GROUPS=()
SKIP_DB_SYNC=false
SKIP_FIXTURE_UP=false
LIST_ONLY=false
NAMES_ONLY=false
JSON_OUTPUT=false
GATE_FILTER="all"
AI_ENV_PREFLIGHT="disabled"
REMOTE_REACHABILITY_MODE="disabled"
KEEP_GOING=false
IGNORED_COUNT="unknown"
SKIPPED_DB_UNAVAILABLE_COUNT="unknown"
IGNORED_PG_ONLY_COUNT="unknown"
IGNORED_PG_REDIS_COUNT="unknown"
IGNORED_PG_AI_COUNT="unknown"
MODULE_SUMMARY="unavailable"
SELECTED_MODULE_SUMMARY="unavailable"
SELECTED_IGNORED_TESTS_COUNT=0
SELECTED_IGNORED_TESTS_RATIO="unknown"
REMOTE_REACHABILITY_TARGETS=""

usage() {
  cat <<'EOF'
Usage:
  scripts/run-server-rs-phase7.sh [group ...] [--dry-run] [--skip-db-sync] [--skip-fixture-up] [--list-only] [--names-only] [--json] [--keep-going] [--gate=pg-only|pg-redis|pg-ai|all]

Groups:
  afdian   Run high-risk Afdian DB-backed tests
  wander   Run high-risk Wander DB-backed tests
  socket   Run game_socket DB-backed tests
  idle     Run idle execution / delta DB-backed tests
  mail     Run mail update / attachment / reward DB-backed tests
  inventory Run inventory use / reroll / craft DB-backed tests
  market   Run market mutation / socket DB-backed tests
  battle   Run battle / battle_session / settlement DB-backed tests
  task     Run task DB-backed tests
  achievement Run achievement DB-backed tests
  team     Run team DB-backed tests
  sect     Run sect DB-backed tests
  arena    Run arena DB-backed tests
  upload   Run upload/avatar DB-backed tests
  all      Run all groups (default)

Examples:
  scripts/run-server-rs-phase7.sh --dry-run
  scripts/run-server-rs-phase7.sh --dry-run --skip-db-sync
  scripts/run-server-rs-phase7.sh --dry-run --skip-fixture-up
  scripts/run-server-rs-phase7.sh afdian --list-only
  scripts/run-server-rs-phase7.sh battle --names-only --gate=pg-redis
  scripts/run-server-rs-phase7.sh all --json --skip-fixture-up --skip-db-sync   # emit JSON plan only
  scripts/run-server-rs-phase7.sh afdian wander --keep-going
  scripts/run-server-rs-phase7.sh battle --gate=pg-redis --list-only
  scripts/run-server-rs-phase7.sh afdian wander
  scripts/run-server-rs-phase7.sh battle mail inventory
  scripts/run-server-rs-phase7.sh socket --dry-run
EOF
}

run_cmd() {
  local description="$1"
  shift
  printf '\n==> %s\n' "$description"
  printf '    %q' "$@"
  printf '\n'
  if [[ "$DRY_RUN" == true ]]; then
    return 0
  fi
  set +e
  "$@"
  local status=$?
  set -e
  return "$status"
}

require_command() {
  local command_name="$1"
  local hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n%s\n' "$command_name" "$hint" >&2
    exit 1
  fi
}

require_env_var() {
  local env_name="$1"
  local hint="$2"
  if [[ -z "${!env_name:-}" ]]; then
    printf 'Missing required environment variable: %s\n%s\n' "$env_name" "$hint" >&2
    exit 1
  fi
}

probe_remote_tcp() {
  local url="$1"
  local label="$2"
  python3 - "$url" "$label" <<'PY'
import socket
import sys
from urllib.parse import urlparse

url = sys.argv[1]
label = sys.argv[2]
parsed = urlparse(url)
host = parsed.hostname
port = parsed.port
if not host or not port:
    print(f"Unable to parse {label} target from URL: {url}", file=sys.stderr)
    sys.exit(1)

sock = socket.socket()
sock.settimeout(3)
try:
    sock.connect((host, port))
except OSError as exc:
    print(f"{label} target {host}:{port} is not reachable: {exc}", file=sys.stderr)
    sys.exit(1)
finally:
    sock.close()
PY
}

run_preflight_checks() {
  if [[ "$SKIP_FIXTURE_UP" != true ]]; then
    require_command docker "Install Docker / Docker Compose before running the local phase-7 baseline with fixture startup enabled."
  fi
  if [[ "$SKIP_DB_SYNC" != true ]]; then
    require_command pnpm "Install pnpm before running server db:sync in the local phase-7 baseline."
  fi
  if [[ "$DRY_RUN" == true ]]; then
    return 0
  fi
  if [[ "$SKIP_FIXTURE_UP" != true ]] && ! docker info >/dev/null 2>&1; then
    printf 'Docker daemon is not reachable. Start Docker Desktop or the Docker service, then retry.\n' >&2
    exit 1
  fi
  if [[ "$SKIP_FIXTURE_UP" == true ]]; then
    case "$GATE_FILTER" in
      pg-only|pg-ai)
        probe_remote_tcp "$DATABASE_URL" "DATABASE_URL"
        ;;
      pg-redis|all)
        probe_remote_tcp "$DATABASE_URL" "DATABASE_URL"
        probe_remote_tcp "$REDIS_URL" "REDIS_URL"
        ;;
    esac
  fi
  if [[ "$GATE_FILTER" == "pg-ai" ]]; then
    require_env_var AI_WANDER_MODEL_PROVIDER "Set AI_WANDER_MODEL_PROVIDER before running pg-ai phase-7 tests."
    require_env_var AI_WANDER_MODEL_URL "Set AI_WANDER_MODEL_URL before running pg-ai phase-7 tests."
    require_env_var AI_WANDER_MODEL_KEY "Set AI_WANDER_MODEL_KEY before running pg-ai phase-7 tests."
    require_env_var AI_WANDER_MODEL_NAME "Set AI_WANDER_MODEL_NAME before running pg-ai phase-7 tests."
  fi
}

append_group_patterns() {
  local group="$1"
  case "$group" in
    afdian)
      GROUP_PATTERNS+=("afdian_")
      ;;
    wander)
      GROUP_PATTERNS+=("wander_" "game_socket_wander_generate_" "wander_ai_resolution_")
      ;;
    socket)
      GROUP_PATTERNS+=("game_socket_")
      ;;
    idle)
      GROUP_PATTERNS+=("idle_" "game_socket_idle_")
      ;;
    mail)
      GROUP_PATTERNS+=("mail_" "game_socket_mail_")
      ;;
    inventory)
      GROUP_PATTERNS+=("inventory_")
      ;;
    market)
      GROUP_PATTERNS+=("market_")
      ;;
    battle)
      GROUP_PATTERNS+=("battle_" "battle_session_" "arena_battle_settlement_")
      ;;
    task)
      GROUP_PATTERNS+=("task_")
      ;;
    achievement)
      GROUP_PATTERNS+=("achievement_")
      ;;
    team)
      GROUP_PATTERNS+=("team_")
      ;;
    sect)
      GROUP_PATTERNS+=("sect_")
      ;;
    arena)
      GROUP_PATTERNS+=("arena_")
      ;;
    upload)
      GROUP_PATTERNS+=("upload_")
      ;;
    all)
      append_group_patterns afdian
      append_group_patterns wander
      append_group_patterns socket
      append_group_patterns idle
      append_group_patterns mail
      append_group_patterns inventory
      append_group_patterns market
      append_group_patterns battle
      append_group_patterns task
      append_group_patterns achievement
      append_group_patterns team
      append_group_patterns sect
      append_group_patterns arena
      append_group_patterns upload
      ;;
    *)
      printf 'Unknown group: %s\n\n' "$group" >&2
      usage >&2
      exit 1
      ;;
  esac
}

build_commands_from_routes() {
  local patterns joined_patterns
  joined_patterns="$(IFS='|'; printf '%s' "${GROUP_PATTERNS[*]}")"
  mapfile -t COMMANDS < <(
    python3 - "$ROUTES_RS_PATH" "$joined_patterns" "$GATE_FILTER" <<'PY'
import re
import sys

routes_path = sys.argv[1]
pattern = re.compile(rf"^(?:{'|'.join(re.escape(p) for p in sys.argv[2].split('|') if p)})")
gate_filter = sys.argv[3]

def classify_gate(block: str) -> str | None:
    if 'SKIPPED_AI_UNAVAILABLE' in block or 'reachable AI provider' in block:
        return 'pg-ai'
    if 'SKIPPED_REDIS_UNAVAILABLE' in block:
        return 'pg-redis'
    if 'connect_fixture_db_or_skip(' in block:
        return 'pg-only'
    return None

def matches_gate(gate: str | None) -> bool:
    if gate is None:
        return False
    if gate_filter == 'all':
        return True
    if gate_filter == 'pg-only':
        return gate == 'pg-only'
    if gate_filter == 'pg-redis':
        return gate == 'pg-redis'
    if gate_filter == 'pg-ai':
        return gate == 'pg-ai'
    raise SystemExit(f'Unknown gate filter: {gate_filter}')

with open(routes_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

names = []
current_name = None
current_block = []

def flush_current():
    if not current_name:
        return
    if pattern.match(current_name) and matches_gate(classify_gate(''.join(current_block))):
        names.append(current_name)

for line in lines:
    stripped = line.strip()
    match = re.match(r'async fn ([a-zA-Z0-9_]+)\(', stripped)
    if match:
        flush_current()
        current_name = match.group(1)
        current_block = [line]
        continue
    if current_name is not None:
        current_block.append(line)

flush_current()

for name in names:
    print(f"cargo test http::routes::tests::{name} -- --nocapture")
PY
  )
}

print_matrix_summary() {
  GATE_TEST_COUNT="unknown"
  SKIPPED_DB_UNAVAILABLE_COUNT="unknown"
  GATE_PG_ONLY_COUNT="unknown"
  GATE_PG_REDIS_COUNT="unknown"
  GATE_PG_AI_COUNT="unknown"
  MODULE_SUMMARY="unavailable"
  SELECTED_MODULE_SUMMARY="unavailable"
  SELECTED_TESTS_COUNT="${#COMMANDS[@]}"
  SELECTED_TESTS_RATIO="unknown"
  if command -v rg >/dev/null 2>&1 && [[ -f "$ROUTES_RS_PATH" ]]; then
    GATE_TEST_COUNT="$(python3 - "$ROUTES_RS_PATH" <<'PY'
import re, sys
count = 0
current = None
block = []
def flush():
    global count
    if current and ('connect_fixture_db_or_skip(' in ''.join(block) or 'SKIPPED_REDIS_UNAVAILABLE' in ''.join(block) or 'SKIPPED_AI_UNAVAILABLE' in ''.join(block)):
        count += 1
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    for line in f:
        stripped = line.strip()
        m = re.match(r'async fn ([A-Za-z0-9_]+)\(', stripped)
        if m:
            flush()
            current = m.group(1)
            block = [line]
        elif current:
            block.append(line)
flush()
print(count)
PY
)"
    SKIPPED_DB_UNAVAILABLE_COUNT="$(rg -c 'SKIPPED_DB_UNAVAILABLE' "$ROUTES_RS_PATH" || printf 'unknown')"
    GATE_PG_ONLY_COUNT="$(rg -c 'connect_fixture_db_or_skip\(' "$ROUTES_RS_PATH" || printf 'unknown')"
    GATE_PG_REDIS_COUNT="$(rg -c 'SKIPPED_REDIS_UNAVAILABLE' "$ROUTES_RS_PATH" || printf 'unknown')"
    GATE_PG_AI_COUNT="$(rg -c 'SKIPPED_AI_UNAVAILABLE' "$ROUTES_RS_PATH" || printf 'unknown')"
    MODULE_SUMMARY="$({
      python3 - "$ROUTES_RS_PATH" <<'PY'
import collections
import re
import sys

routes_path = sys.argv[1]
prefixes = [
    'afdian_', 'wander_', 'game_socket_', 'idle_', 'mail_', 'inventory_', 'market_',
    'battle_session_', 'battle_', 'arena_', 'task_', 'achievement_', 'team_', 'sect_', 'upload_'
]

counts = collections.Counter()
current_name = None
block = []

def classify(block_text: str) -> bool:
    return 'connect_fixture_db_or_skip(' in block_text or 'SKIPPED_REDIS_UNAVAILABLE' in block_text or 'SKIPPED_AI_UNAVAILABLE' in block_text

def flush():
    global current_name, block
    if not current_name:
        return
    if classify(''.join(block)):
        for prefix in prefixes:
            if current_name.startswith(prefix):
                counts[prefix.rstrip('_')] += 1
                break

with open(routes_path, 'r', encoding='utf-8') as f:
    for raw in f:
        stripped = raw.strip()
        match = re.match(r'async fn ([A-Za-z0-9_]+)\(', stripped)
        if match:
            flush()
            current_name = match.group(1)
            block = [raw]
        elif current_name:
            block.append(raw)

flush()

print(','.join(f"{key}={counts[key]}" for key in sorted(counts)))
PY
    } || printf 'unavailable')"
  fi

  if [[ "$GATE_TEST_COUNT" =~ ^[0-9]+$ ]] && (( GATE_TEST_COUNT > 0 )); then
    SELECTED_TESTS_RATIO="$(python3 - <<PY
selected = $SELECTED_TESTS_COUNT
total = $GATE_TEST_COUNT
print(f"{selected}/{total} ({selected/total:.1%})")
PY
)"
  fi

  if ((${#COMMANDS[@]} > 0)); then
    declare -A selected_counts=()
    local command test_name
    for command in "${COMMANDS[@]}"; do
      test_name="${command#cargo test http::routes::tests::}"
      test_name="${test_name%% -- --nocapture}"
      case "$test_name" in
        afdian_*) selected_counts[afdian]=$(( ${selected_counts[afdian]:-0} + 1 )) ;;
        wander_*) selected_counts[wander]=$(( ${selected_counts[wander]:-0} + 1 )) ;;
        game_socket_*) selected_counts[game_socket]=$(( ${selected_counts[game_socket]:-0} + 1 )) ;;
        idle_*) selected_counts[idle]=$(( ${selected_counts[idle]:-0} + 1 )) ;;
        mail_*) selected_counts[mail]=$(( ${selected_counts[mail]:-0} + 1 )) ;;
        inventory_*) selected_counts[inventory]=$(( ${selected_counts[inventory]:-0} + 1 )) ;;
        market_*) selected_counts[market]=$(( ${selected_counts[market]:-0} + 1 )) ;;
        battle_session_*) selected_counts[battle_session]=$(( ${selected_counts[battle_session]:-0} + 1 )) ;;
        battle_*) selected_counts[battle]=$(( ${selected_counts[battle]:-0} + 1 )) ;;
        arena_*) selected_counts[arena]=$(( ${selected_counts[arena]:-0} + 1 )) ;;
        task_*) selected_counts[task]=$(( ${selected_counts[task]:-0} + 1 )) ;;
        achievement_*) selected_counts[achievement]=$(( ${selected_counts[achievement]:-0} + 1 )) ;;
        team_*) selected_counts[team]=$(( ${selected_counts[team]:-0} + 1 )) ;;
        sect_*) selected_counts[sect]=$(( ${selected_counts[sect]:-0} + 1 )) ;;
        upload_*) selected_counts[upload]=$(( ${selected_counts[upload]:-0} + 1 )) ;;
      esac
    done
    SELECTED_MODULE_SUMMARY=""
    local key
    for key in achievement afdian arena battle battle_session game_socket idle inventory mail market sect task team upload wander; do
      if [[ -n "${selected_counts[$key]:-}" ]]; then
        if [[ -n "$SELECTED_MODULE_SUMMARY" ]]; then
          SELECTED_MODULE_SUMMARY+="," 
        fi
        SELECTED_MODULE_SUMMARY+="$key=${selected_counts[$key]}"
      fi
    done
    if [[ -z "$SELECTED_MODULE_SUMMARY" ]]; then
      SELECTED_MODULE_SUMMARY="unavailable"
    fi
  fi

  printf 'Phase 7 groups summary\n'
  for group in "${PHASE7_GROUPS[@]}"; do
    printf '  - %s\n' "$group"
  done
  printf '  - command_count=%s\n' "${#COMMANDS[@]}"
  printf '  - selected_tests=%s\n' "$SELECTED_TESTS_COUNT"
  printf '  - selected_tests_ratio=%s\n' "$SELECTED_TESTS_RATIO"
  printf '  - routes_gate_tests=%s\n' "$GATE_TEST_COUNT"
  printf '  - routes_skipped_db_unavailable_markers=%s\n' "$SKIPPED_DB_UNAVAILABLE_COUNT"
  printf '  - routes_gate_pg_only=%s\n' "$GATE_PG_ONLY_COUNT"
  printf '  - routes_gate_pg_redis=%s\n' "$GATE_PG_REDIS_COUNT"
  printf '  - routes_gate_pg_ai=%s\n' "$GATE_PG_AI_COUNT"
  printf '  - routes_module_distribution=%s\n' "$MODULE_SUMMARY"
  printf '  - selected_module_distribution=%s\n' "$SELECTED_MODULE_SUMMARY"
}

distribution_text_to_json() {
  local text="$1"
  python3 - "$text" <<'PY'
import json
import sys

raw = sys.argv[1]
if raw in ('', 'unavailable', 'unknown'):
    print('null')
    raise SystemExit(0)

result = {}
for chunk in raw.split(','):
    if not chunk or '=' not in chunk:
        continue
    key, value = chunk.split('=', 1)
    try:
        result[key] = int(value)
    except ValueError:
        result[key] = value

print(json.dumps(result, ensure_ascii=False))
PY
}

json_number_or_string() {
  local value="$1"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s' "$value"
  else
    printf '%s' "$value"
  fi
}

while (($# > 0)); do
  if [[ "$1" =~ ^[0-9]+$ ]]; then
    shift
    continue
  fi
  case "$1" in
    --dry-run)
      DRY_RUN=true
      ;;
    --skip-db-sync)
      SKIP_DB_SYNC=true
      ;;
    --skip-fixture-up)
      SKIP_FIXTURE_UP=true
      ;;
    --list-only)
      LIST_ONLY=true
      ;;
    --names-only)
      NAMES_ONLY=true
      ;;
    --json)
      JSON_OUTPUT=true
      ;;
    --keep-going)
      KEEP_GOING=true
      ;;
    --gate=*)
      GATE_FILTER="${1#--gate=}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      PHASE7_GROUPS+=("$1")
      ;;
  esac
  shift
done

if ((${#PHASE7_GROUPS[@]} == 0)); then
  PHASE7_GROUPS=(all)
fi

declare -a COMMANDS=()
declare -a GROUP_PATTERNS=()
for group in "${PHASE7_GROUPS[@]}"; do
  append_group_patterns "$group"
done
build_commands_from_routes

export DATABASE_URL="${DATABASE_URL:-$DATABASE_URL_DEFAULT}"
export REDIS_URL="${REDIS_URL:-$REDIS_URL_DEFAULT}"

if [[ "$SKIP_FIXTURE_UP" == true ]]; then
  case "$GATE_FILTER" in
    pg-only|pg-ai)
      REMOTE_REACHABILITY_TARGETS="DATABASE_URL"
      REMOTE_REACHABILITY_MODE="enabled"
      ;;
    pg-redis|all)
      REMOTE_REACHABILITY_TARGETS="DATABASE_URL,REDIS_URL"
      REMOTE_REACHABILITY_MODE="enabled"
      ;;
  esac
fi

if [[ "$JSON_OUTPUT" != true ]]; then
  printf 'Phase 7 verification baseline\n'
  printf '  ROOT_DIR=%s\n' "$ROOT_DIR"
  printf '  DATABASE_URL=%s\n' "$DATABASE_URL"
  printf '  REDIS_URL=%s\n' "$REDIS_URL"
  printf '  GROUPS=%s\n' "${PHASE7_GROUPS[*]}"
  printf '  DRY_RUN=%s\n' "$DRY_RUN"
  printf '  SKIP_DB_SYNC=%s\n' "$SKIP_DB_SYNC"
  printf '  SKIP_FIXTURE_UP=%s\n' "$SKIP_FIXTURE_UP"
  printf '  LIST_ONLY=%s\n' "$LIST_ONLY"
  printf '  NAMES_ONLY=%s\n' "$NAMES_ONLY"
  printf '  JSON_OUTPUT=%s\n' "$JSON_OUTPUT"
  printf '  KEEP_GOING=%s\n' "$KEEP_GOING"
  printf '  GATE_FILTER=%s\n' "$GATE_FILTER"
  if [[ "$SKIP_FIXTURE_UP" == true ]]; then
    printf '  REMOTE_REACHABILITY_CHECK=%s\n' "$REMOTE_REACHABILITY_TARGETS"
  fi
  if [[ "$GATE_FILTER" == "pg-ai" ]]; then
    AI_ENV_PREFLIGHT="enabled"
    printf '  AI_ENV_PREFLIGHT=enabled\n'
  fi
  print_matrix_summary
else
  if [[ "$GATE_FILTER" == "pg-ai" ]]; then
    AI_ENV_PREFLIGHT="enabled"
  fi
  print_matrix_summary >/dev/null
fi

if [[ "$LIST_ONLY" == true ]]; then
  printf '\nPhase 7 selected tests\n'
  for command in "${COMMANDS[@]}"; do
    printf '%s\n' "$command"
  done
  exit 0
fi

if [[ "$NAMES_ONLY" == true ]]; then
  printf '\nPhase 7 selected test names\n'
  for command in "${COMMANDS[@]}"; do
    test_name="${command#cargo test http::routes::tests::}"
    test_name="${test_name%% -- --nocapture}"
    printf '%s\n' "$test_name"
  done
  exit 0
fi

if [[ "$JSON_OUTPUT" == true ]]; then
  json_sep=$'\x1e'
  json_commands=""
  json_names=""
  if ((${#COMMANDS[@]} > 0)); then
    json_commands="$(IFS="$json_sep"; printf '%s' "${COMMANDS[*]}")"
    mapfile -t _json_names < <(for command in "${COMMANDS[@]}"; do test_name="${command#cargo test http::routes::tests::}"; test_name="${test_name%% -- --nocapture}"; printf '%s\n' "$test_name"; done)
    json_names="$(IFS="$json_sep"; printf '%s' "${_json_names[*]}")"
  fi
  PHASE7_GROUPS_JOINED="${PHASE7_GROUPS[*]}" \
  JSON_COMMANDS="$json_commands" \
  JSON_TEST_NAMES="$json_names" \
  JSON_ROUTES_MODULE_DISTRIBUTION="$(distribution_text_to_json "$MODULE_SUMMARY")" \
  JSON_SELECTED_MODULE_DISTRIBUTION="$(distribution_text_to_json "$SELECTED_MODULE_SUMMARY")" \
  JSON_SEPARATOR="$json_sep" \
  ROOT_DIR_JSON="$ROOT_DIR" \
  GATE_FILTER_JSON="$GATE_FILTER" \
  AI_ENV_PREFLIGHT_JSON="$AI_ENV_PREFLIGHT" \
  REMOTE_REACHABILITY_MODE_JSON="$REMOTE_REACHABILITY_MODE" \
  REMOTE_REACHABILITY_TARGETS_JSON="${REMOTE_REACHABILITY_TARGETS:-}" \
  DRY_RUN_JSON="$DRY_RUN" \
  SKIP_DB_SYNC_JSON="$SKIP_DB_SYNC" \
  SKIP_FIXTURE_UP_JSON="$SKIP_FIXTURE_UP" \
  LIST_ONLY_JSON="$LIST_ONLY" \
  NAMES_ONLY_JSON="$NAMES_ONLY" \
  JSON_OUTPUT_JSON="$JSON_OUTPUT" \
  KEEP_GOING_JSON="$KEEP_GOING" \
  SELECTED_IGNORED_TESTS_JSON="$SELECTED_IGNORED_TESTS_COUNT" \
  SELECTED_IGNORED_TESTS_RATIO_JSON="$SELECTED_IGNORED_TESTS_RATIO" \
  ROUTES_IGNORED_TESTS_JSON="$IGNORED_COUNT" \
  ROUTES_SKIPPED_DB_UNAVAILABLE_JSON="$SKIPPED_DB_UNAVAILABLE_COUNT" \
  ROUTES_IGNORED_PG_ONLY_JSON="$IGNORED_PG_ONLY_COUNT" \
  ROUTES_IGNORED_PG_REDIS_JSON="$IGNORED_PG_REDIS_COUNT" \
  ROUTES_IGNORED_PG_AI_JSON="$IGNORED_PG_AI_COUNT" \
  ROUTES_MODULE_DISTRIBUTION_JSON="$MODULE_SUMMARY" \
  SELECTED_MODULE_DISTRIBUTION_JSON="$SELECTED_MODULE_SUMMARY" \
  python3 - <<'PY'
import json
import os

sep = os.environ.get('JSON_SEPARATOR', '\x1e')
commands = [value for value in os.environ.get('JSON_COMMANDS', '').split(sep) if value]
test_names = [value for value in os.environ.get('JSON_TEST_NAMES', '').split(sep) if value]
groups = [value for value in os.environ.get('PHASE7_GROUPS_JOINED', '').split() if value]
routes_module_distribution = json.loads(os.environ.get('JSON_ROUTES_MODULE_DISTRIBUTION', 'null'))
selected_module_distribution = json.loads(os.environ.get('JSON_SELECTED_MODULE_DISTRIBUTION', 'null'))

payload = {
    'root_dir': os.environ.get('ROOT_DIR_JSON', ''),
    'groups': groups,
    'gate_filter': os.environ.get('GATE_FILTER_JSON', ''),
    'ai_env_preflight': os.environ.get('AI_ENV_PREFLIGHT_JSON', 'disabled'),
    'remote_reachability_mode': os.environ.get('REMOTE_REACHABILITY_MODE_JSON', 'disabled'),
    'remote_reachability_targets': os.environ.get('REMOTE_REACHABILITY_TARGETS_JSON', ''),
    'dry_run': os.environ.get('DRY_RUN_JSON') == 'true',
    'skip_db_sync': os.environ.get('SKIP_DB_SYNC_JSON') == 'true',
    'skip_fixture_up': os.environ.get('SKIP_FIXTURE_UP_JSON') == 'true',
    'list_only': os.environ.get('LIST_ONLY_JSON') == 'true',
    'names_only': os.environ.get('NAMES_ONLY_JSON') == 'true',
    'json_output': os.environ.get('JSON_OUTPUT_JSON') == 'true',
    'keep_going': os.environ.get('KEEP_GOING_JSON') == 'true',
    'selected_tests': int(os.environ.get('SELECTED_IGNORED_TESTS_JSON', '0') or '0'),
    'selected_tests_ratio': os.environ.get('SELECTED_IGNORED_TESTS_RATIO_JSON', 'unknown'),
    'routes_gate_tests': int(os.environ['ROUTES_IGNORED_TESTS_JSON']) if os.environ.get('ROUTES_IGNORED_TESTS_JSON', '').isdigit() else os.environ.get('ROUTES_IGNORED_TESTS_JSON', 'unknown'),
    'routes_skipped_db_unavailable_markers': int(os.environ['ROUTES_SKIPPED_DB_UNAVAILABLE_JSON']) if os.environ.get('ROUTES_SKIPPED_DB_UNAVAILABLE_JSON', '').isdigit() else os.environ.get('ROUTES_SKIPPED_DB_UNAVAILABLE_JSON', 'unknown'),
    'routes_gate_pg_only': int(os.environ['ROUTES_IGNORED_PG_ONLY_JSON']) if os.environ.get('ROUTES_IGNORED_PG_ONLY_JSON', '').isdigit() else os.environ.get('ROUTES_IGNORED_PG_ONLY_JSON', 'unknown'),
    'routes_gate_pg_redis': int(os.environ['ROUTES_IGNORED_PG_REDIS_JSON']) if os.environ.get('ROUTES_IGNORED_PG_REDIS_JSON', '').isdigit() else os.environ.get('ROUTES_IGNORED_PG_REDIS_JSON', 'unknown'),
    'routes_gate_pg_ai': int(os.environ['ROUTES_IGNORED_PG_AI_JSON']) if os.environ.get('ROUTES_IGNORED_PG_AI_JSON', '').isdigit() else os.environ.get('ROUTES_IGNORED_PG_AI_JSON', 'unknown'),
    'routes_module_distribution': routes_module_distribution,
    'selected_module_distribution': selected_module_distribution,
    'commands': commands,
    'test_names': test_names,
}

print(json.dumps(payload, ensure_ascii=False, indent=2))
PY
  exit 0
fi

run_preflight_checks

if [[ "$SKIP_FIXTURE_UP" != true ]]; then
  run_cmd "Validate local fixture compose" docker compose -f "$ROOT_DIR/docker-compose.local-fixture.yml" config
  run_cmd "Start local Postgres and Redis fixture" docker compose -f "$ROOT_DIR/docker-compose.local-fixture.yml" up -d postgres redis
  run_cmd "Wait for Postgres fixture readiness" bash -lc "until docker compose -f \"$ROOT_DIR/docker-compose.local-fixture.yml\" exec -T postgres pg_isready -U postgres -d jiuzhou >/dev/null 2>&1; do sleep 2; done"
  run_cmd "Wait for Redis fixture readiness" bash -lc "until docker compose -f \"$ROOT_DIR/docker-compose.local-fixture.yml\" exec -T redis redis-cli ping >/dev/null 2>&1; do sleep 2; done"
fi

if [[ "$SKIP_DB_SYNC" != true ]]; then
  run_cmd "Sync Prisma schema to local fixture DB" bash -lc "cd \"$ROOT_DIR\" && DATABASE_URL=\"$DATABASE_URL\" pnpm --filter ./server db:sync"
fi

declare -a FAILED_COMMANDS=()
declare -i EXECUTED_COMMANDS_COUNT=0

for command in "${COMMANDS[@]}"; do
  EXECUTED_COMMANDS_COUNT+=1
  if ! run_cmd "Run $command" bash -lc "cd \"$SERVER_RS_DIR\" && $command"; then
    FAILED_COMMANDS+=("$command")
    if [[ "$KEEP_GOING" != true ]]; then
      printf '\nPhase 7 verification baseline aborted on first failing command. Re-run with --keep-going to collect the full failure surface.\n' >&2
      exit 1
    fi
  fi
done

printf '\nPhase 7 verification baseline complete.\n'
printf '  executed_commands=%s\n' "$EXECUTED_COMMANDS_COUNT"
printf '  failed_commands=%s\n' "${#FAILED_COMMANDS[@]}"
if ((${#FAILED_COMMANDS[@]} > 0)); then
  printf '  failed_command_list:\n'
  for command in "${FAILED_COMMANDS[@]}"; do
    printf '    - %s\n' "$command"
  done
  exit 1
fi
