# Operations

## Network

`app.inboxers.io` is the future public application origin. The separate `inboxers.io`
landing site has no shared application cookies. Production public API paths are proxied
through the web service; the server and Postgres remain private Docker-network services.
Fumadocs remains internal until a public documentation audience is chosen.

Local Vite development uses `http://localhost:3001` and proxies to a local Hono server on
port `3000`. The Docker development web service uses `http://localhost:3002`; its Hono
service remains private to the Compose network. Production continues to publish only the
web service through the deployment platform's HTTPS proxy.

## Secrets

Local development uses ignored `.env` files. Until the runtime supports reading Docker
secret files, the future deployment platform injects production secrets as runtime
environment values, including:

- application encryption key and key ID
- provisioner signing secret and transport encryption key (each a base64-encoded 32-byte
  value)
- Polar access token and webhook secret
- Cloudflare API token
- database password

Secrets never enter Git, logs, job payloads, audit events, URLs, or error responses.
Tenant-admin credentials and mailbox passwords are encrypted at rest using an application
key outside Postgres. Tenant-admin credentials are never returned to browser or public API
clients. The API encrypts tenant-admin credentials; the worker decrypts them just in time for
an authenticated private provisioner request, and plaintext remains within that execution
boundary.

## Safe Observability

Duplicate-tenant failures are public-safe and do not identify the owning organization.
Internal structured logs may record safe resource IDs and correlation IDs, but never
credentials, tokens, device codes, browser state, raw PowerShell output, or owner secrets.

## Database Migrations

Database changes follow one workflow: change the Drizzle schema, run `pnpm db:generate`,
review the generated SQL, then run `pnpm db:migrate`. Generated migrations are committed
to Git. Compose runs a one-shot migration service to completion before starting the
server, so server replicas do not run migrations themselves.

## Required Before Launch

- Automated Postgres backups and a documented restore exercise
- Structured request, worker, and job logs with redaction
- Uptime and disk-usage monitoring
- Worker concurrency configuration and tenant/organization locking
- Production secret delivery and rotation procedure
- A recovery drill for worker crash, credential rotation, duplicate billing webhook,
  provisioner failure, and tenant/domain deletion failure

## Detached Zones

When a tenant with SaaS-managed DNS is detached while its Microsoft resources remain,
the Cloudflare zone stays as a detached read-only zone. It is deleted only after the
customer migrates DNS or a confirmed domain-deletion workflow completes.
