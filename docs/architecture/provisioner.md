# Microsoft Provisioner

The Python provisioner is an implemented internal-only service (`apps/provisioner`). It owns
Microsoft execution but not product state, billing, public authorization, or arbitrary command
execution. Live Microsoft behavior still requires the controlled pilot before it is considered
production-proven.

## Boundary

- It is reachable only from Compose networking: the worker and provisioner share an
  `internal: true` network, and the provisioner is additionally attached to an egress-only
  bridge for Microsoft access. It is never on the default application network and publishes no
  host port.
- The worker authenticates each request with an HMAC-SHA-256 signature over the timestamp,
  nonce, and body digest, plus a bounded in-memory replay cache. The provisioner rejects
  malformed, stale, oversized, or replayed requests before decrypting.
- The tenant-validation request payload is additionally encrypted with AES-256-GCM using a
  transport key distinct from signing and at-rest keys, so credentials are never readable on
  the wire.
- The implemented endpoint is the high-level tenant-validation workflow. Later endpoints
  follow the same shape: set up domain, create inboxes, delete inboxes, delete domain, and
  inspect/dispose a tenant session.
- Requests and outcomes use a versioned contract. Results contain resource IDs and safe
  retry classification, never plaintext credentials or raw output.

## Microsoft Authentication

Tenant-admin credentials are supplied as a distinct email/password pair for each tenant
connection, encrypted at rest, and write-only: authorized create/update requests may provide
them, but no browser or public API response returns them. The API encrypts credentials with
AES-256-GCM; the worker decrypts them only immediately before its authenticated private
provisioner request. Plaintext remains confined to that private execution boundary.
Device-code authentication is not a standalone customer feature; the provisioner uses the
credentials for an ephemeral Zendriver browser sign-in, completes device code, then
establishes a tenant-scoped persistent PowerShell session. Graph and Exchange authenticate
in that same process. Initial validation establishes the complete planned session: Graph
requests `User.ReadWrite.All`, `Directory.AccessAsUser.All`, `Domain.ReadWrite.All`,
`Policy.Read.All`, and `Policy.ReadWrite.ConditionalAccess`; Exchange completes its own
device-code connection in that process. Requesting these scopes does not authorize the
product to change tenant policy: no Conditional Access or security-default mutation workflow
exists at launch.

Launch support excludes MFA, Conditional Access, CAPTCHA, risk or security-default
prompts, and other unsupported interactive challenges. Such a challenge fails safely and
needs a later explicit retry once it is compatible. There is no manual handoff, fallback
authentication model, custom customer/platform Entra application-registration flow, or
claim of fully automated Microsoft authentication. Consent prompts are supported when
Microsoft presents them. A non-production Microsoft tenant is required before the real
pilot.

## Session Rules

- One PowerShell process group and session key per tenant connection.
- Never reuse a process across tenants.
- The provisioner keeps an in-memory session registry keyed by tenant connection ID. Each
  entry owns only that tenant's PowerShell process group, verified Microsoft tenant/admin
  identity, and last-used timestamp.
- One active Microsoft job per tenant connection. Different tenant connections may run
  concurrently.
- A verified live session may be reused while valid, but has a 60-minute idle TTL. A
  successful authenticated health check or Microsoft action resets its timer; expiry kills
  its PowerShell process and associated browser work.
- Before every action, verify Graph and Exchange connectivity and that the signed-in UPN
  case-insensitively matches the submitted tenant-admin email and expected Microsoft tenant.
  If that check fails, kill the process group and reauthenticate internally before the action
  begins.
- Credential updates are rejected while tenant work is non-terminal. Otherwise they
  invalidate the session before future work runs.
- Browser profiles and cookies, device codes, tokens, and PowerShell session state are
  never persisted.

## Admission And Runtime

- The launch deployment has one TypeScript worker process and one Python provisioner
  instance on the private Docker network.
- At most three active Microsoft attempts for one organization and five globally may run at
  once. Authentication, health checks, PowerShell commands, and Microsoft polling all count
  as Microsoft work. Retry delays do not hold capacity.
- Exactly one Zendriver authentication flow may run globally. A session reuse does not need
  that browser permit.
- A job waiting for any internal permit remains customer-visible as `processing`; the public
  API exposes neither queue position nor capacity state.
- Development may run Zendriver headfully on the developer machine. Production runs the same
  provisioner headlessly in Docker.

## Retry Split

The provisioner handles short Microsoft-specific polling, such as DNS propagation,
DKIM selector availability, and backing-user availability. The worker handles durable
job retries, crashes, infrastructure failures, and lease recovery.
