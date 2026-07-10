# ADR 0001: Local-first vertical slice

Status: accepted

## Decision

Open Data Fusion starts as a single-node development profile using a TypeScript API, SQLite persistence, and a React Explorer. The API contract and domain model must remain portable to PostgreSQL, Kafka, object storage, and a dedicated time-series serving layer.

## Why

The first milestone must prove one complete workflow without requiring a distributed platform to develop or evaluate it. Local persistence is real persistence, not a frontend fixture; seed data and ingest use the same repository paths.

## Exit condition

Move a workload to distributed infrastructure only when a measured pilot requirement cannot be met by this profile. Raw/event history, transactional model state, and serving projections remain separate architectural responsibilities even when they share SQLite in local development.
