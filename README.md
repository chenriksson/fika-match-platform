# Fika Match Platform

A TypeScript and Node.js prototype for a community matching workflow. The local stack serves the web UI and API, persists data in PostgreSQL, and captures email in Mailpit.

[![CI](https://github.com/chenriksson/fika-match-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/chenriksson/fika-match-platform/actions/workflows/ci.yml)

## Prerequisites

For the recommended setup, install:

- WSL 2 on Windows, with a Linux distribution such as Ubuntu
- Docker Desktop with the WSL 2 based engine enabled
- Git

Docker Desktop uses WSL 2 to run the Linux containers in this project. In Docker Desktop, enable **Use the WSL 2 based engine** and enable integration for your chosen WSL distribution under **Settings > Resources > WSL Integration**.

For host-run development, also install Node.js 22 or later and npm.

## Run with Docker

Start the complete local stack in the background:

```powershell
docker compose up --build -d
```

Open:

- App and API: http://localhost:3000
- API health: http://localhost:3000/api/health
- Mailpit inbox: http://localhost:8025

The stack contains:

- `fika`: Node.js API and static frontend
- `postgres`: PostgreSQL 17 with the named `fika-postgres` volume
- `mailpit`: local SMTP server and email inbox

The database schema and demo group are initialized automatically when the API starts. PostgreSQL is published on `localhost:5432` for host-run tests and development.

Useful Docker commands:

```powershell
# View service status
docker compose ps

# Follow application logs
docker compose logs -f fika

# Stop containers but keep database data
docker compose down

# Stop containers and delete the local database volume
docker compose down -v
```

Do not use `docker compose down -v` unless you intend to delete local PostgreSQL data, including theme settings, rounds, pair history, and captured application state.

## Run on the host

Start PostgreSQL separately, copy the environment template, and install dependencies:

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Set `DATABASE_URL` in `.env` to a PostgreSQL instance reachable from the host. The default value is:

```text
postgres://fika:fika@localhost:5432/fika
```

When `SMTP_HOST` is empty, email notifications are written to the application log instead of being sent. To use Mailpit from a host-run Node process, set:

```env
SMTP_HOST=localhost
SMTP_PORT=1025
MAIL_FROM="Fika <hello@localhost>"
```

## Configuration

The supported environment variables are documented in [.env.example](.env.example):

- `PORT`: API and static site port. Defaults to `3000`.
- `NODE_ENV`: runtime mode. Use `production` when hosted.
- `LOCAL_DEMO_ADMIN`: local-only demo authorization bypass. Keep unset or `false` in production.
- `DATABASE_URL`: PostgreSQL connection string.
- `SESSION_SECRET`: session signing secret. Use a long random value outside local development.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`: SMTP delivery settings.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: optional Google OIDC credentials.
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`: optional Microsoft OIDC credentials.
- `OIDC_SUCCESS_REDIRECT`: redirect target after OIDC login.

Inside Docker Compose, the database and Mailpit hostnames are `postgres` and `mailpit`; do not replace those with `localhost` in the container environment.

## OIDC login

Google login is currently enabled when its credentials are configured. Microsoft login is intentionally hidden and unavailable until its provider configuration is enabled. Register this callback URL with Google using the public app origin:

```text
https://your-app.example.com/auth/callback/google
```

Set the Google client ID and secret in the hosting platform's secret store. The login flow validates the OIDC state and nonce, persists the authenticated user in `app_users`, and links the identity to an existing member when the email matches. Role assignments remain database-controlled; an authenticated user is not automatically a system or group admin.

## Development commands

```powershell
# Watch the TypeScript API during development
npm run dev

# Compile TypeScript to dist/
npm run build

# Run unit and PostgreSQL integration tests
npm test

# Generate terminal and HTML coverage reports
npm run coverage
```

The HTML coverage report is generated at `coverage/index.html`. The PostgreSQL integration test runs when PostgreSQL is available and skips cleanly otherwise.

## Current capabilities

- Responsive workspace overview
- PostgreSQL-backed demo group, members, rounds, matches, and pair history
- Match groups of 2 to 4 people
- Opt-out support before a round
- Configurable cycle reset threshold
- Idempotent round generation with the `Idempotency-Key` header
- Transactional notification outbox
- Post-commit SMTP delivery with leases, retries, and failed state
- Mailpit capture in Docker
- Google and Microsoft OIDC routes when credentials are configured
- Persisted system-admin theme settings, including branding, colors, and light/dark mode
- Authenticated dashboard data for authorized groups, persisted matches, and live metrics
- Self-service member opt-out through `/api/me/opt-out`
- Scoped group administration APIs for group creation, settings, members, and group-admin assignment

## Roles and permissions

The application separates global system administration from group administration:

- `system_admin`: manages global theme and branding, and is allowed to investigate system-level operations. A system admin can also administer every group.
- `user`: has no global administration privileges. Add the user to `group_admins` for the groups they may configure and operate.
- Group admins can manage only their assigned groups, including group configuration, member opt-outs, and match-round generation. They cannot change the global theme.

For local development, Compose sets `LOCAL_DEMO_ADMIN=false` and `NODE_ENV=development`, so the app starts with no active user and requires OIDC login. Set `LOCAL_DEMO_ADMIN=true` temporarily only when you need a local system-admin shortcut. This bypass is disabled automatically when `NODE_ENV=production`; production requests must authenticate through OIDC and resolve to a database user.

After a production user signs in through OIDC, assign system administration or group administration directly in PostgreSQL. Examples:

```sql
UPDATE app_users SET system_role = 'system_admin' WHERE email = 'admin@example.org';
INSERT INTO group_admins (group_id, user_id)
SELECT 'demo', id FROM app_users WHERE email = 'group-admin@example.org'
ON CONFLICT DO NOTHING;
```

The theme endpoints require `system_admin`. Group state, opt-out, configuration, and round-generation endpoints require either `system_admin` or an assignment in `group_admins`.

## API examples

Generate a round with an idempotency key:

```powershell
$key = [guid]::NewGuid().ToString()
Invoke-RestMethod `
	-Method Post `
	-Uri http://localhost:3000/api/groups/demo/matches `
	-Headers @{ 'Idempotency-Key' = $key } `
	-ContentType 'application/json' `
	-Body '{}'
```

The same key returns HTTP `409` rather than creating a second round.

Read or update the persisted theme through `/api/theme`. Theme colors must be six-digit hex values, and `colorMode` must be `light` or `dark`.

Authenticated users can read `/api/dashboard` to load their authorized groups, recent persisted matches, active-member count, and match count. The homepage uses this endpoint after login and shows empty states rather than fabricated demo matches when no data is available.

Group administration is available through `/api/groups/:groupId/config`, `/api/groups/:groupId/members`, and `/api/groups/:groupId/matches`. System admins pass the group-admin authorization check for every group; ordinary group admins are limited to groups listed in `group_admins`.

## Hosting notes

The included Dockerfile builds the TypeScript API in a Node 22 Alpine build stage and runs it in a smaller production stage. A hosted deployment needs:

1. A PostgreSQL database with persistent storage.
2. An SMTP provider or a managed email service.
3. Secret environment variables supplied by the hosting platform.
4. A persistent database migration process instead of relying on startup schema execution.
5. TLS termination and secure session cookies.
6. Authentication and authorization before exposing admin or group operations publicly.

The current Compose setup is for local development, not production. It uses seeded demo data and permissive local defaults. Sessions are stored in PostgreSQL so a normal app restart does not invalidate authenticated users.

## License

This project is released under the MIT License. See [LICENSE](LICENSE).
