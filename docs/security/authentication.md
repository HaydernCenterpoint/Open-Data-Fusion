# Authentication profiles

Open Data Fusion keeps authentication separate from workspace authorization. A
verified identity first resolves to a `userId`; workspace membership then grants
the `owner`, `editor`, `reviewer`, or `viewer` role.

## Development

`ODF_AUTH_MODE=development` accepts `x-odf-user`. The live EventSource may also
use `?user=` because the browser API cannot attach custom headers. This profile
exists only for local multi-tab testing and must not be exposed publicly.

## OIDC resource server

`ODF_AUTH_MODE=oidc` requires a signed bearer access token on every workspace
route. The API validates the signature through the configured JWKS, plus the
token issuer, audience, expiry, and algorithm allowlist. Development headers and
query identities cannot override the verified claim.

Required variables:

```text
ODF_AUTH_MODE=oidc
ODF_OIDC_ISSUER=https://identity.example.com/realms/open-data-fusion
ODF_OIDC_AUDIENCE=open-data-fusion-api
ODF_OIDC_JWKS_URI=https://identity.example.com/realms/open-data-fusion/protocol/openid-connect/certs
```

Optional variables:

```text
ODF_OIDC_USER_CLAIM=sub
ODF_OIDC_ALGORITHMS=RS256
```

Prefer the immutable OIDC `sub` claim and store that value in workspace
membership. A deployment that maps seeded demo usernames may explicitly set
`ODF_OIDC_USER_CLAIM=preferred_username`, accepting that renamed accounts need a
membership migration.

For Keycloak, configure an audience mapper so the access token contains
`open-data-fusion-api` in `aud`. Browser clients should use Authorization Code
with PKCE. Do not use Direct Access Grants or put access tokens in URLs. A
production SSE client must stream with `Authorization: Bearer ...` (for example,
through `fetch`); the development `?user=` mechanism is rejected in OIDC mode.

The React client enables OIDC only when both variables are present:

```text
VITE_OIDC_AUTHORITY=https://identity.example.com/realms/open-data-fusion
VITE_OIDC_CLIENT_ID=open-data-fusion-web
VITE_OIDC_SCOPE=openid profile email
VITE_OIDC_USER_CLAIM=sub
```

It uses Authorization Code with PKCE, stores session state in `sessionStorage`,
renews with the refresh token, and sends access tokens only in the
`Authorization` header. Authenticated live events use a fetch-based SSE parser;
identity is never placed in the event URL. `VITE_OIDC_USER_CLAIM` must match
`ODF_OIDC_USER_CLAIM`, otherwise the API may authorize a member while the UI
cannot map that person to the displayed workspace role.

When `NODE_ENV=production`, the API defaults to OIDC and fails fast if required
configuration is missing. Development mode in production therefore requires an
explicit, visible override and remains unsupported for exposed deployments.
