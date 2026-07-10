# Contributing to Open Data Fusion

Open Data Fusion is developed as an independent clean-room project. Contributions must be original or carry a compatible license and attribution.

## Development

```powershell
npm install
npm run dev
npm run check
```

## Change rules

- Public API, persistence, security-boundary, model, or license changes require an ADR.
- Keep ingest idempotent and attach provenance plus an audit event to accepted writes.
- Treat search, graph indexes, and aggregates as rebuildable projections.
- Never add vendor binaries, copied UI assets, proprietary schemas, customer data, or unlicensed industrial samples.
- Include tests for duplicate delivery, malformed payloads, authorization boundaries, and schema evolution where relevant.
