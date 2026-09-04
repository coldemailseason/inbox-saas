# System Architecture

This is the target architecture. Completed implementation status is recorded in
[`../implementation/next.md`](../implementation/next.md).

## Service Shape

```text
Browser dashboard       Future public API client
        |                       |
      /rpc/*                 /api/v1/*
        |                       |
  browser session          Bearer API key
        \                       /
         \                     /
          web + Hono server
                  |
 Postgres <-> worker <-> private Python provisioner
                  |
              pg-boss jobs
```

- The TanStack Router web app and future public API are independent clients of shared
  Product behavior. The current dashboard organization/workspace strings are an
  operational-contract smoke test, not product dashboard UX.
- Hono currently hosts Better Auth, browser-session `/rpc` adapters, and the limited
  Bearer-key `/api/v1` workspace-read adapter. `/api/v1` never authenticates browser
  sessions, and `/rpc` never authenticates API keys. API-key issuance UI and later public
  API surface remain planned.
- `packages/product` owns transport-neutral Product behavior. Browser and public adapters
  initiate it with resolved access-grant-shaped authority. Workers invoke the provisioner
  with authenticated high-level workflows; the provisioner owns neither public
  authorization nor product rules.
- Postgres will store product state, encrypted credentials, inbox passwords, audit
  events, jobs, outbox records, and entitlement projections.
- The worker will consume durable jobs, own queue retries and leases, and invoke the
  private provisioner.
- The Python provisioner will own Microsoft device-code automation, PowerShell processes,
  short Microsoft/DNS polling, and tenant-scoped session reuse.

## Module Boundaries

| Module                          | Responsibility                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/db`                   | Drizzle schema, migrations, and transaction primitives                                                     |
| `packages/product`              | Transport-neutral authorization, product reads/commands, entitlements, audit events, and state transitions |
| `packages/provisioner-contract` | Versioned request/result schemas shared by worker and provisioner                                          |
| `packages/auth`                 | Better Auth setup, access-grant resolution, and Polar webhook verification                                 |
| `packages/api`                  | oRPC and HTTP transport validation plus actor extraction                                                   |
| `apps/server`                   | Hono composition, public routes, API docs, and health checks                                               |
| `apps/worker`                   | pg-boss consumers, outbox dispatch, leases, retries, and provisioner client                                |
| `apps/provisioner`              | Internal Python HTTP service and Microsoft execution                                                       |

## Command Delivery

Each future mutating command that needs durable work performs authorization, entitlement
checks, state changes, audit event creation, job creation, and outbox insertion in one
database transaction. A dispatcher publishes the outbox entry to pg-boss. This prevents
losing work between a committed product change and queue publication.

Retries are at-least-once delivery. Microsoft workflows must inspect state before
repeating effects; a lost response is an unknown outcome, not permission to rerun a
destructive operation.

## Delivery Direction

The product is backend/API-first. Complete backend vertical slices and their public API
contracts before dashboard product UX; the dashboard remains a client of the same Product
behavior rather than a delivery prerequisite.
