# Pipeline worker

This service polls an explicit, bounded tenant/project allowlist, claims queued
pipeline runs through the PostgreSQL runtime's `FOR UPDATE SKIP LOCKED` queue,
then releases the claim transaction before loading and executing the immutable
pipeline version. Completion uses an expected-state transition, so another
terminal transition wins rather than being overwritten.

Copy `.env.example` to a secret-managed runtime configuration. The PostgreSQL
login should have only the application privileges required by the runtime; do
not use the migrator or superuser login. `ODF_PIPELINE_SCOPES` accepts 1-100
unique UUID pairs, and each poll visits at most
`ODF_PIPELINE_MAX_SCOPES_PER_POLL` of them in round-robin order.

## Executor safety

`ODF_PIPELINE_EXECUTOR` defaults to `disabled`, which prevents startup before
any run can be claimed. `builtin` explicitly enables the deterministic
`builtin-dag-v1` executor. Its immutable definition must contain a non-empty
`steps` array and supports only:

- `noop` with an empty configuration;
- `validate` with `configuration.requiredFields`;
- `quality` with optional `ruleExternalIds` and `failOnError`.

Only `required` and numeric `range` quality rules are evaluated. Regex,
reference, uniqueness, unknown steps, unknown configuration fields, cycles,
and oversized definitions fail closed. The worker never evaluates code,
imports modules from a definition, spawns processes, or executes configured
SQL. Run input is read from `pipeline_runs.summary.input`; persisted result and
error summaries are size-bounded and redact common credential fields.

## Shutdown and failures

SIGINT/SIGTERM stops new claims, waits for current executions for the configured
grace period, then aborts the executor signal. Poll failures use bounded
exponential backoff. Executor failures transition `running` to `failed`; an
expected-state conflict is logged and never overwritten.

Run locally with `npm run dev --workspace @open-data-fusion/pipeline-worker`.
