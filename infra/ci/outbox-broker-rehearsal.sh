#!/usr/bin/env bash
# Rehearses a bounded Redis Streams write outage and two-worker lease race
# against the local/CI production-like Compose topology. It uses disposable
# synthetic rows, restores Redis capacity before recovery, and removes only
# those rows.

set -euo pipefail
umask 077

readonly REQUIRED_CONFIRMATION="local-production-like"
readonly FIXTURE_AGGREGATE_TYPE="outbox-broker-rehearsal"
readonly FIRST_EVENT_TYPE="outbox.broker-rehearsal.first"
readonly SECOND_EVENT_TYPE="outbox.broker-rehearsal.successor"
readonly CONCURRENCY_AGGREGATE_TYPE="outbox-concurrency-rehearsal"
readonly CONCURRENCY_ALPHA_HEAD_EVENT_TYPE="outbox.concurrency.alpha.head"
readonly CONCURRENCY_ALPHA_SUCCESSOR_EVENT_TYPE="outbox.concurrency.alpha.successor"
readonly CONCURRENCY_BETA_HEAD_EVENT_TYPE="outbox.concurrency.beta.head"
readonly CONCURRENCY_BETA_SUCCESSOR_EVENT_TYPE="outbox.concurrency.beta.successor"
readonly CONCURRENCY_STALE_HEAD_EVENT_TYPE="outbox.concurrency.stale.head"
readonly CONCURRENCY_STALE_SUCCESSOR_EVENT_TYPE="outbox.concurrency.stale.successor"
readonly CONCURRENCY_FIXTURE_ROW_COUNT=6
readonly CONCURRENCY_STALE_ATTEMPT_COUNT=7
readonly TEMPORARY_MAXIMUM_ATTEMPTS=2
readonly TEMPORARY_RETRY_DELAY_MILLISECONDS=100
readonly TEMPORARY_POLL_MILLISECONDS=100
readonly TEMPORARY_LEASE_MILLISECONDS=5000
readonly CONCURRENCY_MAXIMUM_ATTEMPTS=12
readonly CONCURRENCY_RETRY_DELAY_MILLISECONDS=1000
readonly CONCURRENCY_LEASE_MILLISECONDS=180000
readonly CONCURRENCY_WRITE_PAUSE_MILLISECONDS=120000

base_compose="${ODF_COMPOSE_BASE:-docker-compose.yml}"
production_like_compose="${ODF_COMPOSE_PRODUCTION_LIKE:-docker-compose.production-like.yml}"
source_database="${ODF_POSTGRES_DB:-odf}"
admin_user="${ODF_POSTGRES_ADMIN_USER:-odf_migrator}"
rehearsal_timeout_seconds="${ODF_OUTBOX_BROKER_REHEARSAL_TIMEOUT_SECONDS:-60}"

writers=(api api-replica outbox-worker pipeline-worker edge-agent)
writer_container_ids_to_restore=()
temporary_worker_containers=()
fixture_insert_attempted="false"
fixture_inserted="false"
concurrency_fixture_insert_attempted="false"
concurrency_fixture_inserted="false"
broker_capacity_constrained="false"
broker_writes_paused="false"
original_redis_maxmemory=""
fixture_id=""
fixture_aggregate_id=""
fixture_topic=""
fixture_stream_key=""
fixture_where=""
first_event_id=""
second_event_id=""
concurrency_fixture_topic=""
concurrency_fixture_stream_key=""
concurrency_fixture_where=""
concurrency_alpha_aggregate_id=""
concurrency_beta_aggregate_id=""
concurrency_stale_aggregate_id=""
concurrency_stale_lease_owner=""
concurrency_alpha_head_event_id=""
concurrency_alpha_successor_event_id=""
concurrency_beta_head_event_id=""
concurrency_beta_successor_event_id=""
concurrency_stale_head_event_id=""
concurrency_stale_successor_event_id=""
rehearsal_complete="false"

fail() {
  echo "outbox broker rehearsal: $*" >&2
  exit 1
}

script_path="${BASH_SOURCE[0]}"
script_directory="${script_path%/*}"
if [[ "$script_directory" == "$script_path" ]]; then
  script_directory="."
fi
repository_root="$(cd -- "$script_directory/../.." && pwd -P)" || fail "could not resolve the repository root"
cd "$repository_root" || fail "could not enter the repository root"

require_environment() {
  if [[ -z "${!1:-}" ]]; then
    fail "$1 is required by the local/CI production-like rehearsal"
  fi
}

compose() {
  docker compose \
    -f "$base_compose" \
    -f "$production_like_compose" \
    --profile production-like "$@"
}

postgres() {
  compose exec -T -e "PGPASSWORD=${ODF_POSTGRES_ADMIN_PASSWORD}" odf-postgres "$@"
}

redis() {
  compose exec -T -e "REDISCLI_AUTH=${ODF_REDIS_PASSWORD}" odf-redis \
    redis-cli --no-auth-warning "$@"
}

postgres_value() {
  local query="$1"
  local result
  result="$(postgres psql \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --quiet \
    --username "$admin_user" \
    --dbname "$source_database" \
    --command "$query")" || return 1
  printf '%s' "$result" | tr -d '\r\n'
}

redis_config_value() {
  local key="$1"
  local result
  local value
  result="$(redis --raw CONFIG GET "$key")" || return 1
  value="$(printf '%s\n' "$result" | awk 'NR == 2 { sub(/\r$/, ""); print; exit }')"
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

redis_info_value() {
  local section="$1"
  local key="$2"
  local result
  local value
  result="$(redis --raw INFO "$section")" || return 1
  value="$(printf '%s\n' "$result" | awk -F: -v expected="$key" '$1 == expected { sub(/\r$/, "", $2); print $2; exit }')"
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

wait_for_postgres_value() {
  local query="$1"
  local expected="$2"
  local description="$3"
  local attempt=0
  local value="<query failed>"

  while (( attempt < rehearsal_timeout_seconds )); do
    if value="$(postgres_value "$query")" && [[ "$value" == "$expected" ]]; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  echo "Timed out waiting for ${description}; last PostgreSQL value was '${value}'" >&2
  return 1
}

remove_temporary_workers() {
  local container
  local removal_failed=0
  local remaining_containers=()

  for container in "${temporary_worker_containers[@]}"; do
    [[ -n "$container" ]] || continue
    if ! docker container inspect "$container" >/dev/null 2>&1; then
      echo "Could not confirm temporary outbox worker '${container}' before removal" >&2
      remaining_containers+=("$container")
      removal_failed=1
      continue
    fi
    if ! docker rm -f "$container" >/dev/null; then
      echo "Could not remove temporary outbox worker '${container}'" >&2
      remaining_containers+=("$container")
      removal_failed=1
      continue
    fi
    if docker container inspect "$container" >/dev/null 2>&1; then
      echo "Temporary outbox worker '${container}' still exists after forced removal" >&2
      remaining_containers+=("$container")
      removal_failed=1
    fi
  done
  temporary_worker_containers=("${remaining_containers[@]}")
  return "$removal_failed"
}

delete_fixture_stream() {
  local stream_key="$1"
  local key_exists

  redis DEL "$stream_key" >/dev/null || return 1
  key_exists="$(redis EXISTS "$stream_key" | tr -d '\r\n')" || return 1
  [[ "$key_exists" == "0" ]]
}

restore_redis_maxmemory() {
  if [[ "$broker_capacity_constrained" != "true" ]]; then
    return 0
  fi
  redis CONFIG SET maxmemory "$original_redis_maxmemory" >/dev/null
  local restored
  restored="$(redis_config_value maxmemory)" || return 1
  if [[ "$restored" != "$original_redis_maxmemory" ]]; then
    echo "Redis maxmemory restoration did not retain its original value" >&2
    return 1
  fi
  broker_capacity_constrained="false"
}

pause_redis_writes() {
  local response

  broker_writes_paused="true"
  response="$(redis CLIENT PAUSE "$CONCURRENCY_WRITE_PAUSE_MILLISECONDS" WRITE)" || return 1
  if [[ "$(printf '%s' "$response" | tr -d '\r\n')" != "OK" ]]; then
    echo "Redis did not acknowledge the bounded write pause" >&2
    return 1
  fi
}

resume_redis_writes() {
  local response

  if [[ "$broker_writes_paused" != "true" ]]; then
    return 0
  fi
  response="$(redis CLIENT UNPAUSE)" || return 1
  if [[ "$(printf '%s' "$response" | tr -d '\r\n')" != "OK" ]]; then
    echo "Redis did not acknowledge write resumption" >&2
    return 1
  fi
  broker_writes_paused="false"
}

start_temporary_worker() {
  local phase="$1"
  local lease_milliseconds="$2"
  local maximum_attempts="$3"
  local maximum_retry_delay_milliseconds="$4"
  local attempt=0
  local state
  local container="odf-outbox-broker-rehearsal-${fixture_id}-${phase}"

  if docker container inspect "$container" >/dev/null 2>&1; then
    echo "Refusing to reuse existing temporary outbox worker '${container}'" >&2
    return 1
  fi
  temporary_worker_containers+=("$container")

  compose run --detach --no-deps --name "$container" \
    -e "ODF_OUTBOX_BATCH_SIZE=1" \
    -e "ODF_OUTBOX_DB_POOL_SIZE=1" \
    -e "ODF_OUTBOX_LEASE_MS=${lease_milliseconds}" \
    -e "ODF_OUTBOX_MAX_ATTEMPTS=${maximum_attempts}" \
    -e "ODF_OUTBOX_MAX_RETRY_DELAY_MS=${maximum_retry_delay_milliseconds}" \
    -e "ODF_OUTBOX_POLL_MS=${TEMPORARY_POLL_MILLISECONDS}" \
    outbox-worker >/dev/null

  while (( attempt < rehearsal_timeout_seconds )); do
    state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
    if [[ "$state" == "running" ]]; then
      return 0
    fi
    if [[ "$state" == "exited" || "$state" == "dead" ]]; then
      docker logs --tail 100 "$container" >&2 || true
      echo "Temporary outbox worker exited before the ${phase} phase" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  echo "Temporary outbox worker did not start for the ${phase} phase" >&2
  return 1
}

run_recovery_cli() {
  compose run --rm --no-deps --entrypoint node outbox-worker \
    apps/outbox-worker/dist/src/recovery-cli.js "$@"
}

is_writer_service() {
  local service="$1"
  local writer
  for writer in "${writers[@]}"; do
    if [[ "$service" == "$writer" ]]; then
      return 0
    fi
  done
  return 1
}

collect_running_writer_containers() {
  local container_ids
  local container_id
  local service
  local state

  writer_container_ids_to_restore=()
  container_ids="$(compose ps --all --quiet)" || return 1
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    service="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$container_id")" || return 1
    if ! is_writer_service "$service"; then
      continue
    fi
    state="$(docker inspect --format '{{.State.Status}}' "$container_id")" || return 1
    case "$state" in
      running) writer_container_ids_to_restore+=("$container_id") ;;
      exited|dead) ;;
      *)
        echo "Writer container '${container_id}' for service '${service}' is '${state}'; refusing to isolate it unsafely" >&2
        return 1
        ;;
    esac
  done <<< "$container_ids"
}

assert_no_active_writer_containers() {
  local container_ids
  local container_id
  local service
  local state
  local active="false"

  container_ids="$(compose ps --all --quiet)" || return 1
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    service="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$container_id")" || return 1
    if ! is_writer_service "$service"; then
      continue
    fi
    state="$(docker inspect --format '{{.State.Status}}' "$container_id")" || return 1
    case "$state" in
      exited|dead) ;;
      *)
        echo "Writer container '${container_id}' for service '${service}' remains '${state}'" >&2
        active="true"
        ;;
    esac
  done <<< "$container_ids"

  [[ "$active" == "false" ]]
}

temporary_worker_name_is_tracked() {
  local container_name="$1"
  local temporary_worker_container

  for temporary_worker_container in "${temporary_worker_containers[@]}"; do
    if [[ "$container_name" == "/${temporary_worker_container}" ]]; then
      return 0
    fi
  done
  return 1
}

assert_only_temporary_workers_active() {
  local container_ids
  local container_id
  local service
  local state
  local container_name
  local temporary_worker_container
  local active="true"

  container_ids="$(compose ps --all --quiet)" || return 1
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    service="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$container_id")" || return 1
    if ! is_writer_service "$service"; then
      continue
    fi
    state="$(docker inspect --format '{{.State.Status}}' "$container_id")" || return 1
    case "$state" in
      running)
        container_name="$(docker inspect --format '{{.Name}}' "$container_id")" || return 1
        if [[ "$service" != "outbox-worker" ]] || ! temporary_worker_name_is_tracked "$container_name"; then
          echo "Unexpected active writer container '${container_name}' for service '${service}'" >&2
          active="false"
        fi
        ;;
      exited|dead) ;;
      *)
        echo "Writer container '${container_id}' for service '${service}' is '${state}' during the two-worker rehearsal" >&2
        active="false"
        ;;
    esac
  done <<< "$container_ids"

  for temporary_worker_container in "${temporary_worker_containers[@]}"; do
    state="$(docker inspect --format '{{.State.Status}}' "$temporary_worker_container" 2>/dev/null)" || {
      echo "Could not confirm temporary outbox worker '${temporary_worker_container}' is running" >&2
      active="false"
      continue
    }
    if [[ "$state" != "running" ]]; then
      echo "Temporary outbox worker '${temporary_worker_container}' is '${state}' during the two-worker rehearsal" >&2
      active="false"
    fi
  done

  [[ "$active" == "true" ]]
}

wait_for_restored_writers() {
  local attempt=0
  local container_id
  local inspection
  local container_name
  local state
  local health
  local report=""
  local all_healthy

  while (( attempt < rehearsal_timeout_seconds )); do
    all_healthy="true"
    report=""
    for container_id in "${writer_container_ids_to_restore[@]}"; do
      inspection="$(docker inspect --format '{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id" 2>/dev/null)" || {
        all_healthy="false"
        report+="${container_id}=missing "
        continue
      }
      IFS='|' read -r container_name state health <<< "$inspection"
      report+="${container_name#/}=${state}/${health} "
      if [[ "$state" != "running" || "$health" != "healthy" ]]; then
        all_healthy="false"
      fi
    done
    if [[ "$all_healthy" == "true" ]]; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  echo "Timed out waiting for restored writer containers to be running and healthy: ${report}" >&2
  return 1
}

restore_writer_containers() {
  local container_id
  local state
  local containers_to_start=()

  for container_id in "${writer_container_ids_to_restore[@]}"; do
    state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null)" || {
      echo "Could not inspect writer container '${container_id}' during restoration" >&2
      return 1
    }
    case "$state" in
      running) ;;
      exited|dead|created) containers_to_start+=("$container_id") ;;
      *)
        echo "Writer container '${container_id}' is '${state}' during restoration" >&2
        return 1
        ;;
    esac
  done

  if (( ${#containers_to_start[@]} > 0 )); then
    docker start "${containers_to_start[@]}" >/dev/null || return 1
  fi
  wait_for_restored_writers
}

stream_event_position() {
  local expected_event_id="$1"
  shift
  local observed_event_id
  local position=0

  for observed_event_id in "$@"; do
    position=$((position + 1))
    if [[ "$observed_event_id" == "$expected_event_id" ]]; then
      printf '%s' "$position"
      return 0
    fi
  done
  return 1
}

run_two_worker_concurrency_rehearsal() {
  local fixture_output
  local stream_length
  local concurrency_lease_state_query
  local concurrency_published_state_query
  local concurrency_stream_output
  local expected_event_id
  local observed_event_id
  local occurrences
  local alpha_head_position
  local alpha_successor_position
  local beta_head_position
  local beta_successor_position
  local stale_head_position
  local stale_successor_position
  local unpublished_events
  local -a concurrency_fixture_event_ids=()
  local -a concurrency_stream_event_ids=()

  assert_no_active_writer_containers || fail "an active writer container appeared before the two-worker lease rehearsal"
  unpublished_events="$(postgres_value "SELECT count(*) FROM odf.outbox_events WHERE published_at IS NULL;")" \
    || fail "could not inspect pending outbox rows before the two-worker lease rehearsal"
  if [[ "$unpublished_events" != "0" ]]; then
    fail "refusing the two-worker lease rehearsal while ${unpublished_events} unpublished outbox row(s) exist"
  fi

  stream_length="$(redis --raw XLEN "$concurrency_fixture_stream_key" | tr -d '\r\n')" \
    || fail "could not inspect the isolated concurrency Redis stream"
  if [[ "$stream_length" != "0" ]]; then
    fail "the isolated concurrency Redis stream '${concurrency_fixture_stream_key}' already exists"
  fi

  start_temporary_worker concurrency-a "$CONCURRENCY_LEASE_MILLISECONDS" "$CONCURRENCY_MAXIMUM_ATTEMPTS" "$CONCURRENCY_RETRY_DELAY_MILLISECONDS"
  start_temporary_worker concurrency-b "$CONCURRENCY_LEASE_MILLISECONDS" "$CONCURRENCY_MAXIMUM_ATTEMPTS" "$CONCURRENCY_RETRY_DELAY_MILLISECONDS"
  assert_only_temporary_workers_active || fail "only the two temporary outbox workers may be active during the lease rehearsal"

  echo "Pausing Redis writes for up to ${CONCURRENCY_WRITE_PAUSE_MILLISECONDS}ms while two real workers claim independent aggregate heads."
  pause_redis_writes || fail "Redis CLIENT PAUSE WRITE is required for the two-worker lease rehearsal"
  concurrency_fixture_insert_attempted="true"

  fixture_output="$(postgres psql \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --quiet \
    --username "$admin_user" \
    --dbname "$source_database" \
    --set="topic=${concurrency_fixture_topic}" \
    --set="alpha_aggregate_id=${concurrency_alpha_aggregate_id}" \
    --set="beta_aggregate_id=${concurrency_beta_aggregate_id}" \
    --set="stale_aggregate_id=${concurrency_stale_aggregate_id}" \
    --set="stale_owner=${concurrency_stale_lease_owner}" \
    --set="alpha_head_event_type=${CONCURRENCY_ALPHA_HEAD_EVENT_TYPE}" \
    --set="alpha_successor_event_type=${CONCURRENCY_ALPHA_SUCCESSOR_EVENT_TYPE}" \
    --set="beta_head_event_type=${CONCURRENCY_BETA_HEAD_EVENT_TYPE}" \
    --set="beta_successor_event_type=${CONCURRENCY_BETA_SUCCESSOR_EVENT_TYPE}" \
    --set="stale_head_event_type=${CONCURRENCY_STALE_HEAD_EVENT_TYPE}" \
    --set="stale_successor_event_type=${CONCURRENCY_STALE_SUCCESSOR_EVENT_TYPE}" \
    --set="stale_attempt_count=${CONCURRENCY_STALE_ATTEMPT_COUNT}" \
    --set="alpha_head_deduplication_key=${fixture_id}-concurrency-alpha-head" \
    --set="alpha_successor_deduplication_key=${fixture_id}-concurrency-alpha-successor" \
    --set="beta_head_deduplication_key=${fixture_id}-concurrency-beta-head" \
    --set="beta_successor_deduplication_key=${fixture_id}-concurrency-beta-successor" \
    --set="stale_head_deduplication_key=${fixture_id}-concurrency-stale-head" \
    --set="stale_successor_deduplication_key=${fixture_id}-concurrency-stale-successor" <<'SQL'
WITH timing AS (
  SELECT clock_timestamp() AS base_time
), inserted AS (
  INSERT INTO odf.outbox_events (
    aggregate_type, aggregate_id, event_type, event_version, topic,
    message_key, payload, headers, deduplication_key, occurred_at,
    available_at, attempt_count, lease_owner, lease_expires_at
  )
  SELECT
    'outbox-concurrency-rehearsal',
    fixture.aggregate_id,
    fixture.event_type,
    1,
    :'topic',
    fixture.aggregate_id,
    jsonb_build_object('rehearsal', true, 'aggregate', fixture.aggregate_label, 'ordinal', fixture.ordinal),
    jsonb_build_object('rehearsal', true),
    fixture.deduplication_key,
    timing.base_time + (fixture.ordinal * interval '1 millisecond'),
    timing.base_time,
    fixture.attempt_count,
    fixture.lease_owner,
    CASE
      WHEN fixture.lease_owner IS NULL THEN NULL
      ELSE timing.base_time - interval '1 second'
    END
  FROM timing
  CROSS JOIN (
    VALUES
      (:'alpha_aggregate_id', :'alpha_head_event_type', 'alpha', 1, :'alpha_head_deduplication_key', 0, NULL::text),
      (:'alpha_aggregate_id', :'alpha_successor_event_type', 'alpha', 2, :'alpha_successor_deduplication_key', 0, NULL::text),
      (:'beta_aggregate_id', :'beta_head_event_type', 'beta', 3, :'beta_head_deduplication_key', 0, NULL::text),
      (:'beta_aggregate_id', :'beta_successor_event_type', 'beta', 4, :'beta_successor_deduplication_key', 0, NULL::text),
      (:'stale_aggregate_id', :'stale_head_event_type', 'stale', 5, :'stale_head_deduplication_key', :'stale_attempt_count'::integer, :'stale_owner'),
      (:'stale_aggregate_id', :'stale_successor_event_type', 'stale', 6, :'stale_successor_deduplication_key', 0, NULL::text)
  ) AS fixture(aggregate_id, event_type, aggregate_label, ordinal, deduplication_key, attempt_count, lease_owner)
  RETURNING event_id, payload
)
SELECT event_id
FROM inserted
ORDER BY (payload ->> 'ordinal')::integer;
SQL
)" || fail "could not insert the six two-worker concurrency fixture rows"
  concurrency_fixture_inserted="true"

  readarray -t concurrency_fixture_event_ids < <(printf '%s\n' "$fixture_output" | tr -d $'\r' | awk 'NF { print }')
  if (( ${#concurrency_fixture_event_ids[@]} != CONCURRENCY_FIXTURE_ROW_COUNT )); then
    fail "expected ${CONCURRENCY_FIXTURE_ROW_COUNT} two-worker concurrency fixture event IDs"
  fi
  concurrency_alpha_head_event_id="${concurrency_fixture_event_ids[0]}"
  concurrency_alpha_successor_event_id="${concurrency_fixture_event_ids[1]}"
  concurrency_beta_head_event_id="${concurrency_fixture_event_ids[2]}"
  concurrency_beta_successor_event_id="${concurrency_fixture_event_ids[3]}"
  concurrency_stale_head_event_id="${concurrency_fixture_event_ids[4]}"
  concurrency_stale_successor_event_id="${concurrency_fixture_event_ids[5]}"
  for expected_event_id in \
    "$concurrency_alpha_head_event_id" \
    "$concurrency_alpha_successor_event_id" \
    "$concurrency_beta_head_event_id" \
    "$concurrency_beta_successor_event_id" \
    "$concurrency_stale_head_event_id" \
    "$concurrency_stale_successor_event_id"; do
    if [[ ! "$expected_event_id" =~ ^[0-9]+$ ]]; then
      fail "PostgreSQL returned an invalid two-worker concurrency fixture event ID"
    fi
  done

  concurrency_lease_state_query="
WITH fixture AS (
  SELECT event_id, published_at, lease_owner, lease_expires_at, available_at, attempt_count, last_error
  FROM odf.outbox_events
  WHERE ${concurrency_fixture_where}
)
SELECT (
  count(*) = ${CONCURRENCY_FIXTURE_ROW_COUNT}
  AND count(*) FILTER (
    WHERE event_id IN (${concurrency_alpha_head_event_id}, ${concurrency_beta_head_event_id})
      AND published_at IS NULL
      AND lease_owner IS NOT NULL
      AND lease_expires_at > clock_timestamp()
      AND attempt_count = 1
      AND last_error IS NULL
  ) = 2
  AND count(DISTINCT lease_owner) FILTER (
    WHERE event_id IN (${concurrency_alpha_head_event_id}, ${concurrency_beta_head_event_id})
  ) = 2
  AND count(*) FILTER (
    WHERE event_id IN (${concurrency_alpha_successor_event_id}, ${concurrency_beta_successor_event_id})
      AND published_at IS NULL
      AND available_at <= clock_timestamp()
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND attempt_count = 0
      AND last_error IS NULL
  ) = 2
  AND count(*) FILTER (
    WHERE event_id = ${concurrency_stale_head_event_id}
      AND published_at IS NULL
      AND lease_owner = '${concurrency_stale_lease_owner}'
      AND lease_expires_at < clock_timestamp()
      AND attempt_count = ${CONCURRENCY_STALE_ATTEMPT_COUNT}
      AND last_error IS NULL
  ) = 1
  AND count(*) FILTER (
    WHERE event_id = ${concurrency_stale_successor_event_id}
      AND published_at IS NULL
      AND available_at <= clock_timestamp()
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND attempt_count = 0
      AND last_error IS NULL
  ) = 1
)
FROM fixture;
"
  wait_for_postgres_value "$concurrency_lease_state_query" "t" "two distinct active aggregate leases with blocked successors"
  assert_only_temporary_workers_active || fail "an unexpected writer container appeared during the two-worker lease assertion"

  resume_redis_writes || fail "could not resume Redis writes after the two-worker lease assertion"

  concurrency_published_state_query="
WITH fixture AS (
  SELECT event_id, published_at, lease_owner, lease_expires_at, attempt_count, last_error
  FROM odf.outbox_events
  WHERE ${concurrency_fixture_where}
)
SELECT (
  count(*) = ${CONCURRENCY_FIXTURE_ROW_COUNT}
  AND count(*) FILTER (
    WHERE published_at IS NOT NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND last_error IS NULL
  ) = ${CONCURRENCY_FIXTURE_ROW_COUNT}
  AND count(*) FILTER (
    WHERE event_id IN (
      ${concurrency_alpha_head_event_id},
      ${concurrency_alpha_successor_event_id},
      ${concurrency_beta_head_event_id},
      ${concurrency_beta_successor_event_id},
      ${concurrency_stale_successor_event_id}
    )
      AND attempt_count = 1
  ) = 5
  AND count(*) FILTER (
    WHERE event_id = ${concurrency_stale_head_event_id}
      AND attempt_count = $((CONCURRENCY_STALE_ATTEMPT_COUNT + 1))
  ) = 1
)
FROM fixture;
"
  wait_for_postgres_value "$concurrency_published_state_query" "t" "two-worker ordered drain and exactly one expired-lease takeover"
  assert_only_temporary_workers_active || fail "an unexpected writer container appeared during the two-worker drain"

  remove_temporary_workers || fail "could not stop the temporary two-worker concurrency publishers"

  concurrency_stream_output="$(redis --raw XRANGE "$concurrency_fixture_stream_key" - +)" \
    || fail "could not read the isolated two-worker concurrency Redis stream"
  readarray -t concurrency_stream_event_ids < <(
    printf '%s\n' "$concurrency_stream_output" | tr -d '\r' \
      | awk 'next_is_event_id { print; next_is_event_id = 0; next } $0 == "eventId" { next_is_event_id = 1 }'
  )
  if (( ${#concurrency_stream_event_ids[@]} != CONCURRENCY_FIXTURE_ROW_COUNT )); then
    fail "the isolated two-worker concurrency Redis stream did not contain exactly ${CONCURRENCY_FIXTURE_ROW_COUNT} events"
  fi
  for expected_event_id in \
    "$concurrency_alpha_head_event_id" \
    "$concurrency_alpha_successor_event_id" \
    "$concurrency_beta_head_event_id" \
    "$concurrency_beta_successor_event_id" \
    "$concurrency_stale_head_event_id" \
    "$concurrency_stale_successor_event_id"; do
    occurrences=0
    for observed_event_id in "${concurrency_stream_event_ids[@]}"; do
      if [[ "$observed_event_id" == "$expected_event_id" ]]; then
        occurrences=$((occurrences + 1))
      fi
    done
    if (( occurrences != 1 )); then
      fail "the isolated two-worker concurrency Redis stream did not contain event '${expected_event_id}' exactly once"
    fi
  done

  alpha_head_position="$(stream_event_position "$concurrency_alpha_head_event_id" "${concurrency_stream_event_ids[@]}")" \
    || fail "could not locate the alpha head in the isolated two-worker concurrency Redis stream"
  alpha_successor_position="$(stream_event_position "$concurrency_alpha_successor_event_id" "${concurrency_stream_event_ids[@]}")" \
    || fail "could not locate the alpha successor in the isolated two-worker concurrency Redis stream"
  beta_head_position="$(stream_event_position "$concurrency_beta_head_event_id" "${concurrency_stream_event_ids[@]}")" \
    || fail "could not locate the beta head in the isolated two-worker concurrency Redis stream"
  beta_successor_position="$(stream_event_position "$concurrency_beta_successor_event_id" "${concurrency_stream_event_ids[@]}")" \
    || fail "could not locate the beta successor in the isolated two-worker concurrency Redis stream"
  stale_head_position="$(stream_event_position "$concurrency_stale_head_event_id" "${concurrency_stream_event_ids[@]}")" \
    || fail "could not locate the expired-lease head in the isolated two-worker concurrency Redis stream"
  stale_successor_position="$(stream_event_position "$concurrency_stale_successor_event_id" "${concurrency_stream_event_ids[@]}")" \
    || fail "could not locate the expired-lease successor in the isolated two-worker concurrency Redis stream"
  if (( alpha_head_position >= alpha_successor_position
    || beta_head_position >= beta_successor_position
    || stale_head_position >= stale_successor_position )); then
    fail "the isolated two-worker concurrency Redis stream did not preserve per-aggregate event order"
  fi

  echo "Two-worker concurrency rehearsal passed: distinct leases, blocked successors, expired-lease takeover, and per-aggregate ordered drain."
}

cleanup() {
  local status="$?"
  local cleanup_failed=0
  local fixture_count
  local concurrency_fixture_count
  local safe_to_restore_writers="true"

  trap - EXIT
  trap '' INT TERM
  set +e

  if ! remove_temporary_workers; then
    echo "Could not remove every temporary outbox worker; preserving Redis state and fixture rows for manual recovery." >&2
    cleanup_failed=1
    safe_to_restore_writers="false"
  fi

  if [[ "$safe_to_restore_writers" == "true" ]] && ! resume_redis_writes; then
    echo "Could not resume Redis writes; preserving Redis state and fixture rows for manual recovery." >&2
    cleanup_failed=1
    safe_to_restore_writers="false"
  fi

  if [[ "$safe_to_restore_writers" == "true" ]] && ! restore_redis_maxmemory; then
    echo "Could not restore Redis maxmemory; preserving fixture rows for manual recovery." >&2
    cleanup_failed=1
    safe_to_restore_writers="false"
  fi

  if [[ "$safe_to_restore_writers" == "true" && "$fixture_insert_attempted" == "true" ]]; then
    if fixture_count="$(postgres_value "SELECT count(*) FROM odf.outbox_events WHERE ${fixture_where};")"; then
      if [[ "$fixture_count" == "0" && "$fixture_inserted" != "true" ]]; then
        echo "The original two-row fixture did not commit; no outbox rows needed cleanup."
      elif [[ "$fixture_count" == "2" ]]; then
        if postgres psql \
          --no-psqlrc \
          --set=ON_ERROR_STOP=1 \
          --quiet \
          --username "$admin_user" \
          --dbname "$source_database" \
          --command "DELETE FROM odf.outbox_events WHERE ${fixture_where};" >/dev/null; then
          if ! delete_fixture_stream "$fixture_stream_key"; then
            echo "Could not confirm removal of the synthetic Redis stream '${fixture_stream_key}'" >&2
            cleanup_failed=1
            safe_to_restore_writers="false"
          fi
        else
          echo "Could not remove the two synthetic outbox rows" >&2
          cleanup_failed=1
          safe_to_restore_writers="false"
        fi
      else
        echo "Refusing to delete synthetic rows: expected exactly 2, found '${fixture_count}'" >&2
        cleanup_failed=1
        safe_to_restore_writers="false"
      fi
    else
      echo "Could not count synthetic outbox rows during cleanup" >&2
      cleanup_failed=1
      safe_to_restore_writers="false"
    fi
  fi

  if [[ "$safe_to_restore_writers" == "true" && "$concurrency_fixture_insert_attempted" == "true" ]]; then
    if concurrency_fixture_count="$(postgres_value "SELECT count(*) FROM odf.outbox_events WHERE ${concurrency_fixture_where};")"; then
      if [[ "$concurrency_fixture_count" == "0" && "$concurrency_fixture_inserted" != "true" ]]; then
        echo "The two-worker concurrency fixture did not commit; no outbox rows needed cleanup."
      elif [[ "$concurrency_fixture_count" == "$CONCURRENCY_FIXTURE_ROW_COUNT" ]]; then
        if postgres psql \
          --no-psqlrc \
          --set=ON_ERROR_STOP=1 \
          --quiet \
          --username "$admin_user" \
          --dbname "$source_database" \
          --command "DELETE FROM odf.outbox_events WHERE ${concurrency_fixture_where};" >/dev/null; then
          if ! delete_fixture_stream "$concurrency_fixture_stream_key"; then
            echo "Could not confirm removal of the synthetic two-worker concurrency Redis stream '${concurrency_fixture_stream_key}'" >&2
            cleanup_failed=1
            safe_to_restore_writers="false"
          fi
        else
          echo "Could not remove the ${CONCURRENCY_FIXTURE_ROW_COUNT} synthetic two-worker concurrency rows" >&2
          cleanup_failed=1
          safe_to_restore_writers="false"
        fi
      else
        echo "Refusing to delete two-worker concurrency rows: expected ${CONCURRENCY_FIXTURE_ROW_COUNT}, found '${concurrency_fixture_count}'" >&2
        cleanup_failed=1
        safe_to_restore_writers="false"
      fi
    else
      echo "Could not count synthetic two-worker concurrency rows during cleanup" >&2
      cleanup_failed=1
      safe_to_restore_writers="false"
    fi
  fi

  if [[ "$safe_to_restore_writers" != "true" ]]; then
    echo "Writer containers remain stopped because temporary-worker removal, Redis restoration, or fixture cleanup was not confirmed safe." >&2
    cleanup_failed=1
  elif (( ${#writer_container_ids_to_restore[@]} > 0 )) && ! restore_writer_containers; then
    echo "Could not restore every stopped writer container to running and healthy state." >&2
    cleanup_failed=1
  fi

  if (( cleanup_failed != 0 )); then
    echo "Outbox broker rehearsal cleanup was incomplete; inspect the messages above before using this stack." >&2
    if (( status == 0 )); then
      status=1
    fi
  elif [[ "$rehearsal_complete" == "true" && "$status" == "0" ]]; then
    echo "Outbox broker outage/dead-letter/recovery/two-worker rehearsal passed; synthetic rows and streams were removed."
  fi

  exit "$status"
}

if [[ "$base_compose" != "docker-compose.yml" || "$production_like_compose" != "docker-compose.production-like.yml" ]]; then
  fail "only docker-compose.yml plus docker-compose.production-like.yml are permitted"
fi
if [[ "${ODF_OUTBOX_BROKER_REHEARSAL_CONFIRM:-}" != "$REQUIRED_CONFIRMATION" ]]; then
  fail "set ODF_OUTBOX_BROKER_REHEARSAL_CONFIRM=${REQUIRED_CONFIRMATION} to confirm this local/CI-only drill"
fi
if [[ ! "$source_database" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
  fail "ODF_POSTGRES_DB is not a safe PostgreSQL identifier"
fi
if [[ ! "$rehearsal_timeout_seconds" =~ ^[0-9]+$ ]] || (( rehearsal_timeout_seconds < 10 || rehearsal_timeout_seconds > 300 )); then
  fail "ODF_OUTBOX_BROKER_REHEARSAL_TIMEOUT_SECONDS must be an integer between 10 and 300"
fi

require_environment ODF_POSTGRES_ADMIN_PASSWORD
require_environment ODF_REDIS_PASSWORD
require_environment ODF_OUTBOX_POSTGRES_URL

outbox_postgres_url_pattern='^postgres(ql)?://[^/@]+@odf-postgres(:5432)?/'"${source_database}"'(\?.*)?$'
if [[ ! "$ODF_OUTBOX_POSTGRES_URL" =~ $outbox_postgres_url_pattern ]]; then
  fail "ODF_OUTBOX_POSTGRES_URL must target local Compose service 'odf-postgres' and database '${source_database}'"
fi

for required_command in docker openssl awk; do
  command -v "$required_command" >/dev/null 2>&1 || fail "${required_command} is required"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

docker_endpoint="${DOCKER_HOST:-}"
if [[ -z "$docker_endpoint" ]]; then
  docker_context="$(docker context show 2>/dev/null)" || fail "could not determine the Docker context"
  docker_endpoint="$(docker context inspect "$docker_context" --format '{{ .Endpoints.docker.Host }}' 2>/dev/null)" \
    || fail "could not inspect the Docker context"
fi
case "$docker_endpoint" in
  unix://*|npipe://*|tcp://127.0.0.1:*|tcp://localhost:*) ;;
  tcp://docker:*)
    [[ -n "${CI:-}" ]] || fail "the Docker endpoint must be local; refusing '${docker_endpoint}'"
    ;;
  *) fail "the Docker endpoint must be local; refusing '${docker_endpoint}'" ;;
esac

compose config --quiet
configured_services="$(compose config --services)"
for required_service in odf-postgres odf-redis outbox-worker; do
  if ! printf '%s\n' "$configured_services" | grep -Fxq "$required_service"; then
    fail "production-like Compose configuration is missing '${required_service}'"
  fi
done

running_services="$(compose ps --services --status running)"
for required_service in odf-postgres odf-redis; do
  if ! printf '%s\n' "$running_services" | grep -Fxq "$required_service"; then
    fail "'${required_service}' must already be running; this script does not bootstrap a stack"
  fi
done

if [[ "$(postgres_value "SELECT to_regclass('odf.outbox_events') IS NOT NULL;")" != "t" ]]; then
  fail "the PostgreSQL database does not contain the migrated ODF outbox table"
fi
if [[ "$(redis PING | tr -d '\r\n')" != "PONG" ]]; then
  fail "Redis PING did not succeed"
fi
if [[ "$(redis_config_value maxmemory-policy)" != "noeviction" ]]; then
  fail "Redis must use maxmemory-policy noeviction for this rehearsal"
fi

recovery_list="$(run_recovery_cli list --limit 1)" || fail "the outbox recovery CLI could not read through ODF_OUTBOX_POSTGRES_URL"
if ! printf '%s' "$recovery_list" | grep -Eq '"mode"[[:space:]]*:[[:space:]]*"read_only"'; then
  fail "the outbox recovery CLI did not return its read-only response"
fi

fixture_id="$(openssl rand -hex 16)" || fail "could not create a synthetic rehearsal identifier"
if [[ ! "$fixture_id" =~ ^[0-9a-f]{32}$ ]]; then
  fail "openssl produced an unsafe synthetic rehearsal identifier"
fi
fixture_aggregate_id="outbox-broker-rehearsal-${fixture_id}"
fixture_topic="outbox-broker-rehearsal-${fixture_id}"
fixture_stream_key="odf:${fixture_topic}"
fixture_where="aggregate_type = '${FIXTURE_AGGREGATE_TYPE}' AND aggregate_id = '${fixture_aggregate_id}' AND topic = '${fixture_topic}' AND event_type IN ('${FIRST_EVENT_TYPE}', '${SECOND_EVENT_TYPE}')"
concurrency_fixture_topic="outbox-concurrency-rehearsal-${fixture_id}"
concurrency_fixture_stream_key="odf:${concurrency_fixture_topic}"
concurrency_alpha_aggregate_id="outbox-concurrency-rehearsal-${fixture_id}-alpha"
concurrency_beta_aggregate_id="outbox-concurrency-rehearsal-${fixture_id}-beta"
concurrency_stale_aggregate_id="outbox-concurrency-rehearsal-${fixture_id}-stale"
concurrency_stale_lease_owner="outbox-concurrency-expired-owner-${fixture_id}"
concurrency_fixture_where="aggregate_type = '${CONCURRENCY_AGGREGATE_TYPE}' AND topic = '${concurrency_fixture_topic}' AND aggregate_id IN ('${concurrency_alpha_aggregate_id}', '${concurrency_beta_aggregate_id}', '${concurrency_stale_aggregate_id}') AND event_type IN ('${CONCURRENCY_ALPHA_HEAD_EVENT_TYPE}', '${CONCURRENCY_ALPHA_SUCCESSOR_EVENT_TYPE}', '${CONCURRENCY_BETA_HEAD_EVENT_TYPE}', '${CONCURRENCY_BETA_SUCCESSOR_EVENT_TYPE}', '${CONCURRENCY_STALE_HEAD_EVENT_TYPE}', '${CONCURRENCY_STALE_SUCCESSOR_EVENT_TYPE}')"

collect_running_writer_containers || fail "could not enumerate every writer container in the selected Compose project"

trap 'exit 130' INT TERM
trap cleanup EXIT

if (( ${#writer_container_ids_to_restore[@]} > 0 )); then
  echo "Stopping ${#writer_container_ids_to_restore[@]} running writer container(s) for the isolated rehearsal."
  docker stop --time 30 "${writer_container_ids_to_restore[@]}" >/dev/null
fi

assert_no_active_writer_containers || fail "an active writer container remains in the selected Compose project; refusing to create synthetic outbox rows"

unpublished_events="$(postgres_value "SELECT count(*) FROM odf.outbox_events WHERE published_at IS NULL;")" || fail "could not inspect pending outbox rows"
if [[ "$unpublished_events" != "0" ]]; then
  fail "refusing to run while ${unpublished_events} unpublished outbox row(s) exist"
fi

original_redis_maxmemory="$(redis_config_value maxmemory)" || fail "could not read Redis maxmemory"
if [[ ! "$original_redis_maxmemory" =~ ^[0-9]+$ ]]; then
  fail "Redis returned an invalid maxmemory value"
fi
if ! redis CONFIG SET maxmemory "$original_redis_maxmemory" >/dev/null; then
  fail "Redis CONFIG SET is required for the bounded local/CI fault injection"
fi
if [[ "$(redis_config_value maxmemory)" != "$original_redis_maxmemory" ]]; then
  fail "Redis did not retain its current maxmemory value during the preflight check"
fi

assert_no_active_writer_containers || fail "an active writer container appeared in the selected Compose project; refusing to create synthetic outbox rows"

fixture_insert_attempted="true"
fixture_output="$(postgres psql \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --tuples-only \
  --no-align \
  --quiet \
  --username "$admin_user" \
  --dbname "$source_database" \
  --set="aggregate_id=${fixture_aggregate_id}" \
  --set="topic=${fixture_topic}" \
  --set="first_deduplication_key=${fixture_id}-first" \
  --set="second_deduplication_key=${fixture_id}-successor" <<'SQL'
WITH inserted AS (
  INSERT INTO odf.outbox_events (
    aggregate_type, aggregate_id, event_type, event_version, topic,
    message_key, payload, headers, deduplication_key
  )
  VALUES
    (
      'outbox-broker-rehearsal',
      :'aggregate_id',
      'outbox.broker-rehearsal.first',
      1,
      :'topic',
      :'aggregate_id',
      jsonb_build_object('rehearsal', true, 'ordinal', 1),
      jsonb_build_object('rehearsal', true),
      :'first_deduplication_key'
    ),
    (
      'outbox-broker-rehearsal',
      :'aggregate_id',
      'outbox.broker-rehearsal.successor',
      1,
      :'topic',
      :'aggregate_id',
      jsonb_build_object('rehearsal', true, 'ordinal', 2),
      jsonb_build_object('rehearsal', true),
      :'second_deduplication_key'
    )
  RETURNING event_id, event_type
)
SELECT event_id
FROM inserted
ORDER BY CASE event_type
  WHEN 'outbox.broker-rehearsal.first' THEN 1
  WHEN 'outbox.broker-rehearsal.successor' THEN 2
  ELSE 3
END;
SQL
)" || fail "could not insert the two synthetic outbox rows"
fixture_inserted="true"

readarray -t fixture_event_ids < <(printf '%s\n' "$fixture_output" | tr -d $'\r' | awk 'NF { print }')
if (( ${#fixture_event_ids[@]} != 2 )); then
  fail "expected two synthetic outbox event IDs"
fi
first_event_id="${fixture_event_ids[0]}"
second_event_id="${fixture_event_ids[1]}"
if [[ ! "$first_event_id" =~ ^[0-9]+$ || ! "$second_event_id" =~ ^[0-9]+$ ]]; then
  fail "PostgreSQL returned an invalid synthetic outbox event ID"
fi

redis_used_memory="$(redis_info_value memory used_memory)" || fail "could not read Redis used_memory"
if [[ ! "$redis_used_memory" =~ ^[0-9]+$ ]] || (( redis_used_memory <= 1 )); then
  fail "Redis used_memory must be greater than one byte before the bounded fault injection"
fi

echo "Constraining Redis maxmemory to force real XADD failures while no normal writer is running."
broker_capacity_constrained="true"
redis CONFIG SET maxmemory 1 >/dev/null
if [[ "$(redis_config_value maxmemory)" != "1" ]]; then
  fail "Redis maxmemory fault injection did not take effect"
fi

start_temporary_worker failure "$TEMPORARY_LEASE_MILLISECONDS" "$TEMPORARY_MAXIMUM_ATTEMPTS" "$TEMPORARY_RETRY_DELAY_MILLISECONDS"

dead_letter_state_query="
SELECT (
  (SELECT published_at IS NULL
          AND available_at = 'infinity'::timestamptz
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
          AND attempt_count = ${TEMPORARY_MAXIMUM_ATTEMPTS}
          AND last_error LIKE 'dead-letter:%'
   FROM odf.outbox_events
   WHERE event_id = ${first_event_id})
  AND
  (SELECT published_at IS NULL
          AND available_at <> 'infinity'::timestamptz
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
          AND attempt_count = 0
   FROM odf.outbox_events
   WHERE event_id = ${second_event_id})
);
"
wait_for_postgres_value "$dead_letter_state_query" "t" "terminal dead-letter state and blocked successor"

remove_temporary_workers || fail "could not stop the temporary failure worker"
restore_redis_maxmemory || fail "could not restore Redis maxmemory before recovery"

dead_letter_reason="local production-like broker capacity restored; synthetic event validated ${fixture_id}"
dry_run_output="$(run_recovery_cli requeue --event-id "$first_event_id" --reason "$dead_letter_reason")" \
  || fail "the recovery CLI dry-run failed"
if ! printf '%s' "$dry_run_output" | grep -Eq '"mode"[[:space:]]*:[[:space:]]*"dry_run"'; then
  fail "the recovery CLI dry-run did not report dry_run mode"
fi
if [[ "$(postgres_value "$dead_letter_state_query")" != "t" ]]; then
  fail "the recovery CLI dry-run changed the dead-lettered synthetic event"
fi

apply_output="$(run_recovery_cli requeue --event-id "$first_event_id" --reason "$dead_letter_reason" --apply)" \
  || fail "the recovery CLI apply step failed"
if ! printf '%s' "$apply_output" | grep -Eq '"mode"[[:space:]]*:[[:space:]]*"applied"'; then
  fail "the recovery CLI apply step did not report applied mode"
fi

requeued_state_query="
SELECT (
  published_at IS NULL
  AND available_at <= now()
  AND attempt_count = 0
  AND lease_owner IS NULL
  AND lease_expires_at IS NULL
  AND last_error LIKE 'requeued: %; previous: dead-letter:%'
)
FROM odf.outbox_events
WHERE event_id = ${first_event_id};
"
if [[ "$(postgres_value "$requeued_state_query")" != "t" ]]; then
  fail "the recovery CLI apply step did not safely requeue the synthetic dead letter"
fi

start_temporary_worker recovery "$TEMPORARY_LEASE_MILLISECONDS" "$TEMPORARY_MAXIMUM_ATTEMPTS" "$TEMPORARY_RETRY_DELAY_MILLISECONDS"

published_state_query="
SELECT (
  (SELECT published_at IS NOT NULL
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
          AND last_error IS NULL
   FROM odf.outbox_events
   WHERE event_id = ${first_event_id})
  AND
  (SELECT published_at IS NOT NULL
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
          AND last_error IS NULL
   FROM odf.outbox_events
   WHERE event_id = ${second_event_id})
);
"
wait_for_postgres_value "$published_state_query" "t" "recovered event and successor publication"

remove_temporary_workers || fail "could not stop the temporary recovery worker"

stream_event_ids="$(redis --raw XRANGE "$fixture_stream_key" - + | awk 'next_is_event_id { print; next_is_event_id = 0; next } $0 == "eventId" { next_is_event_id = 1 }')"
expected_stream_event_ids="$(printf '%s\n%s' "$first_event_id" "$second_event_id")"
if [[ "$stream_event_ids" != "$expected_stream_event_ids" ]]; then
  fail "the synthetic Redis stream did not contain exactly the recovered events in aggregate order"
fi

run_two_worker_concurrency_rehearsal

rehearsal_complete="true"
