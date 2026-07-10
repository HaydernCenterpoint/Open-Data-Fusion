# Local Keycloak profile

This realm is a reproducible development identity provider. It configures a
public browser client using Authorization Code with PKCE, a bearer-only API
audience, and the four users seeded into the example workspace.

Start the isolated development identity stack:

```powershell
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

Configure the browser client with:

```text
VITE_OIDC_AUTHORITY=http://localhost:8080/realms/open-data-fusion
VITE_OIDC_CLIENT_ID=open-data-fusion-web
VITE_OIDC_SCOPE=openid profile email
VITE_OIDC_USER_CLAIM=preferred_username
```

`ODF_DEMO_USER_PASSWORD` is substituted while importing the realm. The Compose
profile supplies a documented local fallback; override it in `.env` before
starting. The same password is intentionally shared by all four demo users and
must never be used outside local development.

The Keycloak `start-dev` profile uses insecure HTTP and local storage. A
production deployment must use an optimized image, HTTPS, external PostgreSQL,
backup/restore, restricted admin access, and secret management.
