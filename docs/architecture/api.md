# Public API

The public API is a first-class product interface for people and agents. It is separate
from browser RPC and internal worker/provisioner traffic. The API-key backend, workspace
read, tenant-validation command, and job read endpoints are implemented and route-tested.
Customers cannot use them yet: API-key issuance remains unavailable until deliberate
dashboard UI work, and no public key-management routes exist.

## Contract

- Base path: `/api/v1`.
- `/rpc/*` is the browser-session adapter. `/api/v1/*` accepts Bearer API keys only and
  never authenticates browser sessions, including when both credentials are sent.
- `GET /api/v1/workspaces` returns `{ "workspaces": [...] }`. Organization keys receive
  organization workspaces; workspace keys receive only their workspace.
- `POST /api/v1/workspaces/:workspaceId/tenant-connections` requires workspace `write`,
  JSON write-only credentials, and `Idempotency-Key`. It returns `202` with a safe tenant
  connection/job resource and echoes the key. It creates a tenant-validation operation,
  not a customer-visible login session.
- `GET /api/v1/jobs/:jobId` returns an authorized credential-free job and tenant resource.
- Both adapters call shared Product behavior with access-grant-shaped authority.
- Later public endpoints will define explicit HTTP method, path, request/output schema,
  status codes, operation ID, and metadata. Reference documentation, OpenAPI hosting,
  CORS, and customer key-management are deferred.

## Authentication And Authority

- API keys are opaque credentials sent as `Authorization: Bearer <key>`.
- Keys are generated once, shown once, stored only as hashes, and can expire or be
  revoked.
- A key has one permission: `read` or `write`. `write` includes `read` within the same
  scope.
- A key is either organization-wide or scoped to one workspace.
- Resource authorization derives the resource's organization and workspace from storage
  and rejects access outside the key's boundary.
- `read` accesses non-secret product state. `write` permits all implemented write
  actions in scope. Tenant-admin credentials are never returned through this API or the
  browser; any future mailbox-password reveal requires `write`.
- The initial API has no granular permission matrix. Deletion endpoints are introduced
  deliberately later, not implied by `write` before they exist.
- Workspace-owned collection and action endpoints require an explicit `workspace_id`.
  Workspace creation requires explicit organization context and organization-wide `write`
  authority; workspace-scoped keys cannot create workspaces. Individual-resource endpoints
  derive workspace ownership from their resource ID.
- API requests have no mutable current-workspace server state.
- Missing, malformed, unknown, expired, and revoked keys all return
  `401 { "code": "unauthorized" }` with `WWW-Authenticate: Bearer`.

## Commands And Jobs

- When command endpoints are introduced, caller-generated `Idempotency-Key` is required only
  for commands that create Microsoft
  work or consume scarce capacity. Clients generate and retain it before their first
  request.
- The same key with the same operation and payload returns the original result or job;
  reuse for a different operation or payload fails safely. Reads and ordinary local
  metadata edits do not require a key.
- Microsoft-affecting commands return `202 Accepted` and a job resource.
- Clients poll the job resource for `processing`, `completed`, or `failed`.
- Capacity admission, retry delays, authentication, and reauthentication are internal job
  phases. They never introduce a public `queued` status, queue position, or session detail.
- Failed jobs include a stable safe failure code, retryability, and allowed recovery
  action. They never expose credentials, device codes, tokens, or raw PowerShell output.
- Customer webhooks are deferred until event delivery, signature, retry, and replay
  semantics are specified.

## API Shape

Use resource-oriented groups such as organizations, workspaces, tenant connections,
domains, inbox plans, inboxes, jobs, and API keys. Keep resource context explicit for
collection and action endpoints. Do not copy third-party APIs that rely on a mutable
workspace selection or a global all-workspaces API key.
