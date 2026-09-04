# inbox-saas

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines React, TanStack Router, Hono, ORPC, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **TanStack Router** - File-based routing with full type safety
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Shared UI package** - shadcn/ui primitives live in `packages/ui`
- **Hono** - Lightweight, performant server framework
- **oRPC** - End-to-end type-safe APIs with OpenAPI integration
- **Node.js** - Runtime environment
- **Drizzle** - TypeScript-first ORM
- **PostgreSQL** - Database engine
- **Authentication** - Better-Auth
- **Oxlint** - Oxlint + Oxfmt (linting & formatting)
- **Turborepo** - Optimized monorepo build system

## Getting Started

First, install the dependencies:

```bash
pnpm install
```

## Database Setup

This project uses PostgreSQL with Drizzle ORM.

Start the local Docker Postgres service:

```bash
pnpm db:start
```

Configure `apps/server/.env` from `apps/server/.env.example` with local development
credentials. For every database change: update the schema, run `pnpm db:generate`,
review the generated SQL, then run `pnpm db:migrate`. Generated migrations are
committed to Git; schema push is not a project workflow. Compose runs a one-shot
migration service before starting the server.

Then run the development server:

```bash
pnpm dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the web application.
Vite and Nginx proxy the application API paths through the same origin.

For a full-container smoke test, run `pnpm docker:up` and open
[http://localhost:3002](http://localhost:3002). Vite always uses port `3001` and fails
instead of choosing a different port when it is unavailable.

## Integration Tests

Integration tests require a separate PostgreSQL database. Create and migrate it once:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -T postgres \
  psql -U postgres -d postgres -c 'CREATE DATABASE "inbox-saas-test";'
DATABASE_URL=postgresql://postgres:password@localhost:5432/inbox-saas-test \
  pnpm --filter @inbox-saas/db run db:migrate
```

Run the database-backed suite only against that isolated database:

```bash
TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/inbox-saas-test \
  pnpm test:integration
```

## UI Customization

React web apps in this stack share shadcn/ui primitives through `packages/ui`.

- Change design tokens and global styles in `packages/ui/src/styles/globals.css`
- Update shared primitives in `packages/ui/src/components/*`
- Adjust shadcn aliases or style config in `packages/ui/components.json` and `apps/web/components.json`

### Add more shared components

Run this from the project root to add more primitives to the shared UI package:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components like this:

```tsx
import { Button } from "@inbox-saas/ui/components/button";
```

### Add app-specific blocks

If you want to add app-specific blocks instead of shared primitives, run the shadcn CLI from `apps/web`.

## Deployment

### Docker Compose

- Local Docker uses `docker-compose.yml` with `docker-compose.dev.yml` through the root
  `docker:*` and `db:*` scripts.
- Build images: `pnpm docker:build`
- Start: `pnpm docker:up`
- Logs: `pnpm docker:logs`
- Stop: `pnpm docker:down`

Future production uses `docker-compose.yml` with `docker-compose.production.yml`. That
overlay publishes only the web service; the deployment platform supplies the required
runtime environment values, including the private database URL.

### Native Provisioner Development

The provisioner remains private in Compose and has no published host port. To develop its
Microsoft browser flow locally, run it natively with a visible browser instead:

```bash
INBOX_PROVISIONER_HEADLESS_BROWSER=false \
INBOX_PROVISIONER_SIGNING_SECRET="$INBOX_PROVISIONER_SIGNING_SECRET" \
INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY="$INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY" \
uv run --directory apps/provisioner uvicorn inbox_provisioner.main:app --host 127.0.0.1 --port 8000
```

Run the real worker separately with `DATABASE_URL`,
`TENANT_CREDENTIAL_ENCRYPTION_KEY`, `TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION`, and
`INBOX_PROVISIONER_SIGNING_SECRET` configured in its environment, plus:

```bash
PROVISIONER_BASE_URL=http://127.0.0.1:8000 pnpm --filter worker dev
```

`INBOX_PROVISIONER_SIGNING_SECRET` must be the same base64-encoded random 32-byte value in
both processes. Generate one with `openssl rand -base64 32`.
`INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY` must be a separate shared base64-encoded random
32-byte value. Generate it with `openssl rand -base64 32`.

`apps/worker/.env.example` lists the complete real-worker environment. The fake runner is
development-only and requires explicit `pnpm --filter worker dev:fake` invocation.

For more details, see the guide on [Deploying with Docker Compose](https://www.better-t-stack.dev/docs/guides/docker).

## Git Hooks and Formatting

- Run checks: `pnpm run check`

## Project Structure

```
inbox-saas/
├── apps/
│   ├── web/         # Frontend application (React + TanStack Router)
│   └── server/      # Backend API (Hono, ORPC)
├── packages/
│   ├── ui/          # Shared shadcn/ui components and styles
│   ├── api/         # API layer / business logic
│   ├── auth/        # Authentication configuration & logic
│   └── db/          # Database schema & queries
```

## Available Scripts

- `pnpm run dev`: Start all applications in development mode
- `pnpm run build`: Build all applications
- `pnpm run dev:web`: Start only the web application
- `pnpm run dev:server`: Start only the server
- `pnpm run check-types`: Check TypeScript types across all apps
- `pnpm test:integration`: Run database-backed tests against `TEST_DATABASE_URL`
- `pnpm db:generate`: Generate a migration from the schema; review its SQL before commit
- `pnpm db:migrate`: Run committed database migrations
- `pnpm run db:studio`: Open database studio UI
- `pnpm run check`: Run Oxlint and Oxfmt
- `pnpm run docker:build`: Build the Docker Compose images
- `pnpm run docker:up`: Build and start the Docker Compose stack
- `pnpm run docker:logs`: Tail logs from the Docker Compose stack
- `pnpm run docker:down`: Stop the Docker Compose stack
