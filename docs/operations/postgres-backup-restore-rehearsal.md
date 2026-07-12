# PostgreSQL backup and restore rehearsal

The rehearsal proves that a quiesced logical backup can be parsed, restored in
one transaction to an isolated database, and reproduce every ODF table and
sequence fingerprint. It does not replace encrypted backup storage, PITR/WAL
archiving, or the object-store version backup.

## Preconditions

- Use the migrator/backup credential only inside the controlled job.
- Stop `api`, `api-replica`, `outbox-worker`, `pipeline-worker`, and
  `edge-agent`. The script refuses to run while any writer is active.
- Ensure enough free space for the custom-format dump and the temporary
  restored database.
- For a complete recovery boundary, separately snapshot all object versions
  and KMS material at the same named recovery point.

Production-like CI performs:

```bash
docker compose -f docker-compose.yml -f docker-compose.production-like.yml \
  --profile production-like stop api api-replica outbox-worker
bash infra/ci/postgres-backup-restore-rehearsal.sh
```

The script:

1. validates the migrated source and writer quiescence;
2. creates a custom-format `pg_dump` with a SHA-256 checksum;
3. verifies the dump catalog contains the ODF schema;
4. restores it to the reserved `odf_restore_rehearsal` database with
   `--single-transaction --exit-on-error`;
5. compares deterministic row/count fingerprints for every `odf` table and
   state for every `odf` sequence;
6. drops the isolated database even after failure.

By default all temporary files are deleted. To retain a rehearsal artifact,
set `ODF_BACKUP_REHEARSAL_ARTIFACT_DIR` to an encrypted, access-controlled
location. The dump contains real tenant data and must never be uploaded as a
public CI artifact.

## Restore acceptance

Record dump checksum, source recovery timestamp, PostgreSQL version, duration,
row/sequence fingerprint result, and operator. Then validate a representative
tenant/project, raw replay, governed-object version, Canvas revision, and audit
correlation against the matched object-store snapshot. Measure actual restore
time against the agreed RTO and the snapshot interval/WAL position against RPO.

Do not direct application traffic to the rehearsal database. A real restore
requires new least-privilege credentials, RLS verification, object locator
reconciliation, and an explicit cutover/rollback decision.
