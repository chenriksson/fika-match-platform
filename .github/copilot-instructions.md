# Copilot instructions for this repository

## Project purpose
This project is a TypeScript and Node.js prototype for a community matching workflow. The app uses a PostgreSQL-backed API and static frontend, with Mailpit for local SMTP capture.

## Core workflow
- Keep changes focused on the app behavior and repository integration.
- Prefer small, surgical changes that preserve the current architecture.
- Validate with the smallest existing test or build command relevant to the changed behavior.
- Do not introduce unnecessary dependencies or broad refactors.

## Development notes
- Run the app locally with Docker Compose for the full stack or host-run PostgreSQL with `npm run dev`.
- Respect the existing `npm run build` and `npm test` flow.
- Keep environment variables aligned with `.env.example`.
- Do not hardcode local-only database or SMTP settings into committed code.

## Repository expectations
- Keep PRs scoped and easy to review.
- Prefer clear commit messages and small incremental changes.
- Document user-facing behavior changes when they affect local development or deployment.
