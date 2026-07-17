# ADR 0007: Data modeling and bounded graph query

- Status: Accepted
- Date: 2026-07-17

## Context

Open Data Fusion needs an open, clean-room data-modeling capability with the
same functional shape expected from an industrial data-fusion platform:
versioned models, typed views, managed node and edge instances, filtering,
bounded traversal, and aggregation. The capability must work in the local
SQLite profile and the production PostgreSQL profile without introducing a
second public contract or a separate graph service.

Published model definitions are operational contracts. Mutating them in place
would make stored instances ambiguous and prevent deterministic replay.
Unbounded filters or graph traversal would also allow a single request to
consume disproportionate database resources.

## Decision

### Independent, REST-first public contract

We implement clean-room functional parity with independent Open Data Fusion
API shapes, UI, naming, and source code. A single REST module owns model,
version, view, instance, query, traversal, and aggregate endpoints. GraphQL is
not introduced for this capability.

### One selected persistence port

Application routes depend on one `ModelGraphPersistence` port. At startup the
API selects exactly one implementation: SQLite for the local profile or
PostgreSQL for the production profile. There is no dual write, read fallback,
or runtime reconciliation between the two profiles.

PostgreSQL extends the normalized `data_models`, `model_views`, and
`graph_instances` tables. SQLite mirrors the same public contract. A graph
database or graph microservice is not added.

Public model versions use the oldest provisioned model space in the project,
ordered by `created_at` and then `space_id`, as their deterministic default
space. This keeps model identifiers stable without exposing internal space
selection to API clients.

### Immutable published versions

A model version starts as a draft. Views may be added only while it is a draft,
and a version must contain at least one view before publication. Publication is
the only permitted state transition. Published definitions are immutable;
changes require a new version.

Managed instances must reference a view in the selected model version. Nodes
and edges are keyed by `(space, externalId)`, and edges must point to nodes in
the same project. Upsert batches are atomic and idempotent, and replacing an
existing instance replaces its complete property set.

### Bounded grammar and execution

The public grammar supports typed properties, boolean filter composition,
equality, membership, range and existence predicates, stable keyset paging,
bounded recursive traversal, and bounded aggregation. Validation caps request
size and expression depth before persistence. PostgreSQL model operations use
a five-second local statement timeout.

The initial UI exposes Versions, Views, Instances, and Query workflows. A
schema canvas and graph visualization are outside this slice.

## Consequences

- Both persistence profiles have one testable public behavior contract.
- PostgreSQL retains relational transactions, row-level security, audit, and
  outbox guarantees for model operations.
- Published models are reproducible and safe to cache, but edits require a new
  version.
- Query expressiveness is intentionally constrained to protect multi-tenant
  availability.
- More advanced transformations, workflows, schema visualization, and graph
  analytics remain follow-on capabilities.
