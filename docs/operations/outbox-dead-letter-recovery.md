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
