# Security policy

Open Data Fusion is pre-release software and must not be connected to a production OT network.

Please report suspected vulnerabilities privately to the maintainers. Do not open a public issue containing exploit details, credentials, sensitive plant data, or unsafe reproduction steps.

The project follows these defaults:

- Industrial connectors are read-only unless a separately reviewed capability explicitly says otherwise.
- Edge communication is outbound-only and authenticated.
- Secrets are never committed, returned by APIs, or written to audit details.
- Public deployments use verified OIDC bearer tokens; `x-odf-user` and `?user=` are local-development mechanisms only.
- Workspaces enforce authorization server-side, and membership changes cannot remove the final owner.
- Contextualization candidates require an explicit review policy before becoming accepted relations.
- A production release requires dependency, container, SBOM, license, and authorization review.
