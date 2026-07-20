# Outbox broker failure, dead-letter, and recovery

## Safety model

PostgreSQL is authoritative. Redis Streams is a delivery transport, not the
recovery source. The publisher processes leased events in durable order and
never marks a row published before Redis acknowledges `XADD`.

A failed attempt clears its lease and applies bounded exponential backoff. On
the configured final attempt, the worker sets `available_at` to PostgreSQL
`infinity`, keeps `published_at` null, and prefixes the sanitized error with
`dead-letter:`. The dead-letter row deliberately remains the unpublished
predecessor for its aggregate. Do not publish a later event manually around it.

Prometheus raises:

- `OdfOutboxWorkerDown` when the worker target is unreachable;
- `OdfOutboxBrokerUnavailable` when Redis is not ready;
- `OdfOutboxBacklogStale` when a deliverable event is older than five minutes;
- `OdfOutboxDeadLettersPresent` when an aggregate is blocked.

## Broker outage

1. Stop deploys and schema changes that could complicate the incident.
2. Confirm PostgreSQL is healthy and `published_at` is still null for pending
   events. Do not delete or rewrite those rows.
3. Restore Redis persistence/networking and verify `PING` plus Redis Streams
   capacity. Redis must use `maxmemory-policy noeviction`.
4. Watch `odf_outbox_redis_ready`, pending count, oldest age, and publish
   failures. Delivery is at-least-once; consumers must deduplicate by event ID
   or `deduplicationKey`.

## Local/CI broker-write outage and two-worker lease rehearsal

`infra/ci/outbox-broker-rehearsal.sh` is a standalone drill for an already
running, migrated `docker-compose.yml` + `docker-compose.production-like.yml`
stack. It is intentionally fail-closed: it accepts only those two Compose
files, requires a local Docker endpoint plus
`ODF_OUTBOX_BROKER_REHEARSAL_CONFIRM=local-production-like`, and requires the
same production-like environment used to start the stack, including
`ODF_POSTGRES_ADMIN_PASSWORD`, `ODF_REDIS_PASSWORD`, and
`ODF_OUTBOX_POSTGRES_URL`. The script rejects a publisher URL unless it names
the local Compose `odf-postgres` service and the selected `ODF_POSTGRES_DB`,
so a one-off worker or recovery `--apply` cannot be directed at another
database.

```bash
export ODF_OUTBOX_BROKER_REHEARSAL_CONFIRM=local-production-like
bash infra/ci/outbox-broker-rehearsal.sh
```

The drill is safe only for the disposable local/CI reference topology. It
enumerates every `api`, `api-replica`, `outbox-worker`, `pipeline-worker`, and
`edge-agent` container in the selected Compose project, fails on an unstable
writer state, and stops the exact running container IDs. It verifies no writer
container remains active both after stopping them and immediately before it
creates synthetic rows. It restores only the exact containers it stopped after
Redis and synthetic-row cleanup are confirmed.

For a deterministic real Redis failure without changing Compose or storing a
test credential, the script records Redis `maxmemory`, verifies the required
`noeviction` policy, and temporarily sets `maxmemory` to one byte. The real
outbox worker can connect but its real `XADD` calls are rejected by Redis. A
one-off worker uses two attempts and short retry timings only for the drill.
The script asserts in PostgreSQL that the first synthetic event has a terminal
`dead-letter:` error, `available_at = infinity`, no lease, and no
`published_at`; it also asserts that its same-aggregate successor remains
unattempted and unpublished.

It then stops that worker, restores the exact original Redis capacity setting,
runs the existing recovery CLI once in dry-run mode and once with `--apply`,
and verifies the applied row was safely requeued. A second real worker drains
the recovered event and its successor. The script requires both rows to be
marked published in PostgreSQL and verifies that the isolated Redis stream has
exactly those event IDs in aggregate order.

The same isolated lifecycle then runs a bounded two-worker lease phase. It
first confirms that no unpublished rows exist and starts two separately named
real outbox worker containers with a batch size of one while no concurrency
fixture exists. It verifies that those are the only active writer containers,
then calls Redis `CLIENT PAUSE <bounded-ms> WRITE` and inserts six rows in one
transaction: head/successor pairs for independent `alpha`, `beta`, and
pre-expired-lease aggregates. This avoids consuming the bounded pause budget
while containers are starting. The script asserts that the `alpha` and `beta`
heads have distinct active lease owners while their successors remain
unclaimed. The stale head starts at attempt seven; after `CLIENT UNPAUSE`, the
script requires all six rows to publish, requires its attempt count to become
exactly eight, and verifies that the unique stream contains each fixture event
once with every head before its own successor. This proves that the seeded
expired-lease row was claimed exactly once in this controlled, no-crash
execution.

Cleanup traps stop every temporary worker before it resumes Redis writes or
restores Redis capacity. It deletes only the exact synthetic rows and their
unique streams, then verifies each stream is absent. It waits up to the
configured rehearsal timeout for every restored writer container to be both
`running` and Docker-health `healthy`; an unhealthy or missing writer fails
cleanup. If a temporary worker cannot be confirmed removed, a row count is
unexpected, Redis restoration/write resumption fails, or stream deletion
cannot be verified, it preserves the affected state and leaves normal writer
services stopped for manual recovery.

This is an automated exception to the normal second-operator `--apply` gate
only because it operates on freshly generated synthetic rows in the local/CI
reference stack. Do not use it against a deployed environment or to recover a
real event.

### What this drill does not prove

The bounded write-capacity fault is not a Redis process crash, network
partition, DNS/TLS failure, persistence loss, failover, or managed-service
outage. Redis remains connected, so it does not prove the
`OdfOutboxBrokerUnavailable` alert or external notification routing. The
controlled two-worker phase proves neither high-volume multi-instance load
contention nor global ordering between aggregates. Its one-entry-per-fixture
stream assertion is intentionally limited to a no-crash run; it does not prove
exactly-once delivery across a worker loss, lease expiry race, Redis `XADD`
success followed by PostgreSQL failure, or consumer processing. It also does
not test the production attempt/retry configuration, real producer or consumer
payloads and deduplication, or a second operator's approval. Those require
separate environment-specific rehearsal.

## Inspect dead letters

Use the least-privilege outbox publisher URL, never the migrator URL:

```bash
export ODF_POSTGRES_URL='postgresql://<outbox-login>:<managed-secret>@<host>:5432/odf'
npm run recovery --workspace @open-data-fusion/outbox-worker -- list --limit 100
```

The listing intentionally omits payload and headers. Correlate `eventId`,
`aggregateId`, `correlationId`, audit logs, and sanitized `lastError`. Before
requeueing, prove the broker is healthy and the payload producer/consumer bug
is fixed. Check for later events on the same aggregate; they are expected to be
blocked.

## Requeue gate

First run without `--apply` and attach the JSON dry-run output to the incident:

```bash
npm run recovery --workspace @open-data-fusion/outbox-worker -- \
  requeue --event-id 42 --reason "INC-1234 broker restored; payload validated"
```

After a second operator approves, repeat with `--apply`. Requeue resets the
attempt counter, makes the event immediately available, and preserves the prior
error inside `last_error`. Verify the specific event becomes published before
closing the incident, then confirm the aggregate's successors drain in order.

Never recover by directly setting `published_at`, deleting the event, or
changing its payload. Those actions destroy auditability or ordering.
