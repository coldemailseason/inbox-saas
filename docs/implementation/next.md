# Implementation Next Steps

Read [`../README.md`](../README.md) and the linked topical documents before changing
product behavior. This roadmap orders work by dependency, not by UI visibility.

## Completed Baseline

- Better-T-Stack scaffold with Hono, oRPC, Better Auth, Polar, Drizzle, Postgres,
  Docker, Turborepo, evlog, and Fumadocs
- Initial Better Auth migration committed; local Postgres reconstructs from migrations
- Local sign-up, sign-in, dashboard, API, and Fumadocs smoke-tested
- Polar sandbox token and placeholder subscription product configured
- Internal documentation and initial architecture decisions recorded
- Organization, workspace, and scoped access-grant schema migrated with an isolated
  Postgres integration suite for read authorization and cross-organization constraints
- Better Auth signup atomically creates the initial organization, `Default` workspace,
  and creator `write` grant
- Control-plane extraction complete: shared organization/workspace reads now live in
  `packages/product`; `/rpc` is a browser-session adapter. Current dashboard
  organization/workspace strings are an operational-contract smoke test, not product UX.
- API-key backend complete with scoped, expiring, revocable keys and the route-tested,
  Bearer-only `GET /api/v1/workspaces` read slice. Customer API-key issuance remains
  deferred to deliberate dashboard UI work.
- Tenant-validation foundation implemented and verified: encrypted write-only credentials
  with workspace/operation AAD binding, temporary unlimited organization entitlement,
  organization-wide idempotency, safe public job projection (`processing`/`completed`/
  `failed` only), transactional outbox, job-level retry eligibility, strict lease fencing,
  a local fake-worker entrypoint, and pg-boss lifecycle coverage.
- Real tenant-authentication provisioner implemented: signed HMAC/replay-protected and
  AES-256-GCM-encrypted private transport; one Python provisioner and one worker in Compose
  on an internal network; Zendriver device-code completion (headful in local development,
  headless in production); Graph and Exchange device-code authentication in one persistent,
  tenant-scoped PowerShell process; an in-memory session registry with 60-minute idle TTL
  and pre-action health/identity verification; worker admission of three active Microsoft
  attempts per organization and five globally with one global Zendriver permit. The fake
  provisioner remains development-only and refuses production. Remaining before this slice
  closes: the controlled non-production Microsoft pilot.

## Database Migration Workflow

For each schema change, run `pnpm db:generate`, review the generated SQL, then run
`pnpm db:migrate`. Compose runs its migration service once before the server starts.

## Prerequisites

These do not block the control-plane foundation, but block their named milestones:

| Prerequisite                                                                       | Needed by                                |
| ---------------------------------------------------------------------------------- | ---------------------------------------- |
| Licensed US, French, and Spanish name-data source                                  | Inbox generator                          |
| Dedicated non-production Microsoft 365 tenant without unsupported login challenges | Real provisioner pilot                   |
| SaaS-owned Cloudflare account and narrowly scoped API token                        | Managed DNS integration                  |
| App encryption key, provisioner service secret, and Polar webhook secret           | Product services and billing integration |
| Polar sandbox one-time credit product                                              | End-to-end entitlement testing           |
| Backup storage and monitoring provider                                             | Production launch                        |

## Planned Slices

1. **Close tenant validation with the controlled Microsoft pilot.** The fake-backed
   vertical's lease-expiry fence, job-level retry eligibility, credential AAD, local
   fake-worker entrypoint, real private Python provisioner, signed/encrypted transport,
   session registry, admission limits, and single-VPS Compose deployment are implemented
   and verified by automated tests. Remaining: run the controlled pilot against a
   dedicated non-production Microsoft tenant (see
   `apps/provisioner/tests/manual/tenant-validation-pilot.md`) to prove live device-code
   output parsing, Zendriver selectors, authentication timing, session reuse, and
   transparent reauthentication. Capacity waiting remains public `processing`. The fake
   provisioner is never deployed as real Microsoft functionality.
2. **Domains, inboxes, and deletion.** Add domain and inbox planning/provisioning, then
   deliberate deletion actions and their recovery semantics.
3. **Dashboard and API-key UI.** Build the real dashboard and deliberate API-key issuance
   UI as clients of the already-delivered Product behavior.
4. **Billing.** Add paid entitlements and Polar integration.
5. **External-beta hardening.** Complete documentation, monitoring, backups, recovery
   drills, rate limits, and operational hardening for external customers.

## Deferred Decisions

- Exact plan names, prices, and future tenant-slot counts
- Name-data provider, licensing, and full locale catalog
- Inbox-plan preview editing and CSV export details
- Customer webhook delivery and replay model
- Public Fumadocs deployment and custom domain
- Backup and monitoring provider
