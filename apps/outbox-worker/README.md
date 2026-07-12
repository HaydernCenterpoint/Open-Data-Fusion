# Durable outbox worker

The worker leases ordered rows from PostgreSQL and publishes them to Redis
Streams. PostgreSQL remains the delivery source of truth. A broker
acknowledgement is followed by a guarded `published_at` update under the same
lease owner.

Failed deliveries use bounded exponential backoff. After
`ODF_OUTBOX_MAX_ATTEMPTS` (default `12`) the event is retained in PostgreSQL
with `available_at = infinity` and a sanitized `dead-letter:` error. That event
continues to block later unpublished events for the same aggregate, preserving
ordering until an operator recovers it.

Operational settings:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `ODF_OUTBOX_BATCH_SIZE` | `50` | Maximum rows leased per poll |
| `ODF_OUTBOX_LEASE_MS` | `30000` | Ownership lease duration |
| `ODF_OUTBOX_POLL_MS` | `1000` | Empty/error poll delay |
| `ODF_OUTBOX_MAX_ATTEMPTS` | `12` | Poison-event dead-letter ceiling |
| `ODF_OUTBOX_MAX_RETRY_DELAY_MS` | `300000` | Retry backoff ceiling |
| `ODF_OUTBOX_METRICS_PORT` | `9465` | Internal Prometheus endpoint |

List dead letters without payload disclosure:

```bash
npm run recovery --workspace @open-data-fusion/outbox-worker -- list --limit 100
```

Requeue is dry-run by default and requires both an event ID and incident reason:

```bash
npm run recovery --workspace @open-data-fusion/outbox-worker -- \
  requeue --event-id 42 --reason "broker recovered and payload validated"

npm run recovery --workspace @open-data-fusion/outbox-worker -- \
  requeue --event-id 42 --reason "broker recovered and payload validated" --apply
```

See [the recovery runbook](../../docs/operations/outbox-dead-letter-recovery.md)
before applying a requeue.
