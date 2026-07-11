# Local Keycloak profile

This realm is a reproducible development identity provider. It configures a
public browser client using Authorization Code with PKCE, a bearer-only API
audience, and the four users seeded into the example workspace.

Start the isolated development identity stack:

```powershell
$env:KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME = "local-admin-name"
$env:KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD = "<value-from-secret-manager>"
$env:ODF_DEMO_USER_PASSWORD = "<value-from-secret-manager>"
$env:ODF_CONNECTOR_CLIENT_SECRET = "<value-from-secret-manager>"
docker compose -f docker-compose.identity.yml up -d
```

Copy the repository `.env.example` to `.env`, uncomment the API and browser OIDC
variables below, and then run `npm run dev`. Both workspaces read the same root
environment file.

The realm issuer is `http://localhost:8080/realms/open-data-fusion`. Set the API
to OIDC mode with:

```text
ODF_AUTH_MODE=oidc
ODF_OIDC_ISSUER=http://localhost:8080/realms/open-data-fusion
ODF_OIDC_AUDIENCE=open-data-fusion-api
ODF_OIDC_JWKS_URI=http://localhost:8080/realms/open-data-fusion/protocol/openid-connect/certs
ODF_OIDC_USER_CLAIM=preferred_username
```

The realm defines API client roles for `data:read`, `data:ingest`,
`relations:review`, `audit:read`, `platform:admin`, and three independent
write-back roles. Demo users receive least-purpose role
sets, while the `open-data-fusion-connector` confidential client has a service
account limited to `data:read` and `data:ingest`. Set a unique
`ODF_CONNECTOR_CLIENT_SECRET` before importing the realm and use the client
credentials grant only from a protected connector runtime; never ship that
secret to the browser.

Configure the browser client with:

```text
VITE_OIDC_AUTHORITY=http://localhost:8080/realms/open-data-fusion
VITE_OIDC_CLIENT_ID=open-data-fusion-web
VITE_OIDC_SCOPE=openid profile email
VITE_OIDC_USER_CLAIM=preferred_username
```

`ODF_DEMO_USER_PASSWORD` is substituted while importing the realm. Compose
requires an explicit value and has no checked-in fallback. The same password is
intentionally shared by all four demo users and must never be used outside
local development.

The Keycloak `start-dev` profile uses insecure HTTP and local storage. A
production deployment must use an optimized image, HTTPS, external PostgreSQL,
backup/restore, restricted admin access, and secret management.
