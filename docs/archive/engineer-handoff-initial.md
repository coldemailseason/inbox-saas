# Engineer Handoff

## Product Summary

This product is a SaaS for provisioning Microsoft 365 cold email infrastructure.

Customers bring their own Microsoft 365 tenant admin credentials. The platform stores those credentials encrypted, validates them through Microsoft device-code authentication, then uses Microsoft Graph PowerShell and Exchange Online PowerShell to set up domains, DNS requirements, DKIM, shared mailboxes, and cleanup actions.

The customer-facing app should feel like a simple provisioning dashboard. Microsoft authentication sessions, PowerShell process management, retries, DNS/Microsoft waiting states, and queue details are internal implementation details.

## Locked Stack

Use Better-T-Stack with this baseline:

```bash
pnpm create better-t-stack@latest inbox-saas \
  --frontend tanstack-router \
  --backend hono \
  --runtime node \
  --api orpc \
  --auth better-auth \
  --payments polar \
  --database postgres \
  --orm drizzle \
  --db-setup docker \
  --package-manager pnpm \
  --git \
  --web-deploy docker \
  --server-deploy docker \
  --install \
  --addons mcp skills lefthook oxlint turborepo evlog fumadocs \
  --examples none
```

Manual additions after scaffold:

- `shadcn/ui`
- `pg-boss`
- Python provisioner internal service
- PowerShell session manager
- credit/entitlement model
- backup/restore scripts
- basic monitoring

Why these choices:

- `tanstack-router`: app/dashboard-first React frontend.
- `hono`: lightweight API backend.
- `node`: safest runtime for hiring, production compatibility, queues, browser automation integration, and ops.
- `orpc`: type-safe app API with OpenAPI-compatible future.
- `better-auth`: user auth from day one.
- `polar`: billing from day one to avoid later entitlement rewrites.
- `postgres` + `drizzle`: relational workflow/state-heavy product with explicit TypeScript schema.
- `docker`: local development and VPS deployment should use the same service shape.
- `turborepo`: monorepo task orchestration.
- `evlog`: structured logs are important for provisioning/support.
- `fumadocs`: internal educational docs will be part of the product later.
- `mcp` + `skills`: AI-heavy development environment.

## Product Model

Foundational model:

```text
User
Organization
Membership
Workspace
Workspace Access / Permissions
Microsoft Tenant Connection
Domain
Inbox
Provisioning Job
Subscription / Entitlement
Tenant Onboarding Credits
```

Rules:

- A user logs in and belongs to one or more organizations.
- An organization owns billing, subscriptions, credits, tenant slots, and workspaces.
- A workspace is a client/project/container under an organization.
- Workspaces are for organization and permissions; they are not billing units.
- Users may later invite VAs/team members into an organization.
- Users may later grant members access to all workspaces or specific workspaces.
- Billing is not seat-based.
- Billing is not workspace-based.
- Billing is based on organization subscription plus tenant onboarding credits.
- A Microsoft tenant connection is the managed Microsoft 365 tenant account.
- A tenant connection has one active custom domain at a time.
- A tenant connection supports up to 100 inboxes.

## Billing Model

Locked billing rules:

- Billing is organization-level.
- A subscription grants platform access and active tenant slots.
- All paid plans have the same backend job concurrency policy.
- Concurrency is internal only; it is not a plan differentiator at launch.
- Tenant onboarding credits are purchased separately as one-time products.
- One tenant onboarding credit equals one Microsoft tenant onboarding.
- Adding a Microsoft tenant reserves one onboarding credit.
- When credential validation succeeds, the reserved credit is consumed.
- If credential validation fails, the reserved credit is released.
- Purchased credits never expire.
- An active subscription is required to use the platform and consume credits.
- Removing a tenant frees the active tenant slot but does not refund the consumed onboarding credit.
- Re-adding the same Microsoft tenant later consumes a new onboarding credit.
- Once onboarded, that tenant can swap domains without consuming additional credits.
- Domain swaps are intended to be virtually unlimited and should be a product value prop.
- Each tenant can have one active custom domain at a time.
- Each tenant can have up to 100 inboxes.
- Inbox creation, deletion, and recreation under the same tenant do not consume additional onboarding credits.

Polar product shape for MVP:

- One recurring subscription product for platform access.
- One or more plan tiers controlling active tenant slots.
- One one-time product for tenant onboarding credits.
- One internal/free/unlimited organization plan for founder testing.

The founder account should exercise normal entitlement code paths through an internal/free plan, not hardcoded billing bypasses.

## UX Rules

Do not expose a persistent “connected” concept to users.

Microsoft authentication is not a standalone product feature. Credentials are a prerequisite for actions like tenant validation, domain setup, inbox creation, inbox deletion, and domain deletion.

Customer-facing statuses should be simple:

```text
processing
completed
failed
```

Queued and running jobs can both show as `processing`.

Detailed internal states like these should be support/admin logs, not primary customer UI:

```text
PowerShell session created
PowerShell session reused
Microsoft auth started
Microsoft auth failed
waiting for DNS
waiting for Microsoft propagation
waiting for DKIM selectors
```

Primary tenant actions:

- remove tenant
- delete domain
- delete inboxes

Definitions:

- `remove tenant`: removes the tenant from the platform. It does not necessarily delete Microsoft resources.
- `delete domain`: explicit action to remove the active domain from Microsoft/DNS workflow.
- `delete inboxes`: explicit action to remove provisioned inboxes/mailboxes.

MVP cancellation policy:

- Users can cancel queued jobs.
- Running Microsoft jobs should not expose a cancel button at first.
- Microsoft operations are not transactional, so running cancellation should not imply rollback.
- If partial work happens, expose clear state and recovery actions later.

Per-inbox status should exist because mailbox creation can partially succeed.

Suggested per-inbox statuses:

```text
generated
queued_for_creation
creating
created
failed
queued_for_deletion
deleting
deleted
delete_failed
```

## Execution Architecture

Target service architecture:

```text
Frontend:
  TanStack Router app

TypeScript server:
  Hono + oRPC
  Better Auth
  Polar billing
  Drizzle/Postgres
  product permissions
  entitlement checks
  job creation
  admin/support views later

TypeScript worker:
  pg-boss job consumer
  queue retries
  cancellation policy
  global/org/tenant concurrency
  calls Python provisioner over private HTTP

Python provisioner:
  internal-only HTTP service
  requires internal service token
  owns device-code browser automation
  owns Microsoft Graph PowerShell and Exchange Online commands
  owns persistent PowerShell sessions
  one session key per tenantConnectionId
  one active job per tenantConnectionId
  60-minute idle TTL
  validates expected Microsoft account before session reuse
  short Microsoft-specific polling/retries

Postgres:
  product state
  encrypted Microsoft tenant credentials
  jobs/job logs
  audit events
  subscriptions/entitlements
  tenant credit state
```

Local development should use Docker Compose for all services, matching production service shape as closely as practical:

```text
web
server
worker
python-provisioner
postgres
```

Use dev overrides for mounted source code, watch mode, and local ports. The goal is to avoid rewriting infrastructure when moving from local development to a VPS.

## Python Provisioner

The Python provisioner owns Microsoft execution.

Important clarification: the app API uses `oRPC`. Microsoft calls are separate from the app API layer and are executed as PowerShell cmdlets from Microsoft Graph PowerShell and Exchange Online PowerShell.

The TypeScript app should expose product actions through oRPC, such as:

```text
createTenant
validateTenantCredentials
setupDomain
createInboxes
deleteInboxes
deleteDomain
removeTenant
retryJob
cancelQueuedJob
```

The TypeScript worker should translate queued product jobs into internal calls to the Python provisioner.

The Python provisioner should expose high-level internal workflow endpoints, not arbitrary raw PowerShell execution endpoints.

Suggested internal endpoints:

```text
POST /tenant-connections/:id/validate
POST /tenant-connections/:id/setup-domain
POST /tenant-connections/:id/create-inboxes
POST /tenant-connections/:id/delete-inboxes
POST /tenant-connections/:id/delete-domain
GET  /tenant-connections/:id/session
```

Avoid exposing a generic `run-powershell-command` endpoint. It is too dangerous unless heavily locked down for internal diagnostics.

The Python provisioner should only be reachable on the private Docker network and should require an internal service token from the TypeScript worker.

## PowerShell Session Rules

Microsoft Graph and Exchange Online authentication state lives inside the PowerShell process that authenticated.

For this reason, tenant Microsoft actions should reuse a persistent tenant-scoped PowerShell session when possible.

Rules:

- One persistent PowerShell session per tenant connection.
- Session key is `tenantConnectionId`.
- Do not reuse a PowerShell process across tenants.
- One active Microsoft job per tenant connection.
- Different tenant connections may run concurrently up to global/org limits.
- Idle session TTL is 60 minutes.
- Expired sessions are killed and recreated when needed.
- Stale/broken sessions are killed and recreated.
- Before reuse, validate Graph and Exchange are still connected.
- Before reuse, validate the connected Microsoft account matches the expected tenant admin email.
- If validation fails, authenticate again using stored encrypted credentials.

Recommended PowerShell process start:

```bash
pwsh -NoExit -Command -
```

Commands should be written to stdin.

Read stdout/stderr continuously.

To know when a command is complete, append a unique sentinel after each command:

```powershell
Write-Host "__PWSH_DONE_<uuid>__:"$LASTEXITCODE
```

Then read process output until that sentinel appears.

This avoids guessing whether the PowerShell command has finished.

## Queue And Jobs

Use `pg-boss` for a Postgres-backed queue.

Reasoning:

- The app already depends on Postgres.
- Workload is low-throughput and externally bottlenecked by Microsoft/DNS.
- Jobs are slow and durable, not high-frequency realtime work.
- Avoid Redis until there is a clear need.

Concurrency rules:

- One active Microsoft job per tenant connection.
- Per-organization active job/session cap.
- Global active job/session cap.
- Overflow jobs stay queued.
- All paid plans use the same backend concurrency rules at launch.
- Concurrency is not user-visible beyond `processing` status.

Retry split:

- Python handles short Microsoft-specific polling/retries.
- Node/pg-boss handles whole-job retries, crashes, durable state, and queue-level retries.

Examples of Python-level retries:

- wait for domain verification
- wait for DKIM selectors
- wait for backing Graph user after mailbox creation

Examples of Node/queue-level retries:

- provisioner unavailable
- worker crash
- whole job timeout
- transient infrastructure failure

## Security Requirements

Microsoft admin credentials must be stored encrypted.

Credential policy:

- Storing encrypted credentials is required.
- Do not offer a “do not store password” option in the MVP.
- Credentials are required for future background jobs and re-authentication.
- No standalone credential delete action while the tenant exists.
- Credential update is allowed.
- Updating credentials should invalidate/kill any active PowerShell session for that tenant connection.
- Tenant removal can remove stored credentials as part of removing the tenant record.

Encryption requirements:

- Use an app-level encryption secret outside the database.
- Store the encryption secret outside Git.
- On a VPS, provide it through environment or Docker secret.
- Do not rely on database-only encryption.
- If the app secret is lost, encrypted Microsoft passwords become unrecoverable.

Internal service security:

- Python provisioner is private to the Docker network.
- Python provisioner still requires an internal service token.
- Never expose Python provisioner directly to the public internet.
- Do not expose arbitrary PowerShell execution to users.

Audit/logging:

Add minimal audit events early. They do not need to be a polished user-facing audit dashboard at launch.

Useful events:

```text
tenant.created
tenant.credentials.updated
tenant.auth.validation_succeeded
tenant.auth.validation_failed
tenant.microsoft_action.started
tenant.microsoft_action.succeeded
tenant.microsoft_action.failed
job.retry_requested
job.cancel_requested
```

## Deployment And Ops

Initial deployment target is a single VPS with Docker Compose.

Cloudflare Workers is not a good fit for the core provisioning workload because the product needs long-running jobs, Python browser automation, PowerShell process/session management, and durable operational logs.

Production launch blockers:

- automated Postgres backups
- documented restore test
- structured app/job logs
- disk usage monitoring
- basic uptime monitoring
- secrets outside Git
- app-level encryption secret outside DB
- worker concurrency config
- per-org/tenant job locking

Postgres can be self-hosted in Docker initially to keep costs low, but backups and restore testing are mandatory before production users.

## Microsoft Integration Overview

Microsoft integration is PowerShell-based.

It uses:

- Microsoft Graph PowerShell for user/domain/directory operations.
- Exchange Online PowerShell for mailbox, DKIM, and transport operations.
- Device-code authentication for both Graph and Exchange.
- Browser automation to complete the Microsoft device login flow.

Required PowerShell modules:

```powershell
Import-Module Microsoft.Graph.Authentication
Import-Module Microsoft.Graph.Users
Import-Module Microsoft.Graph.Identity.DirectoryManagement
Import-Module ExchangeOnlineManagement
```

The runtime machine/container needs:

- PowerShell 7
- Microsoft Graph PowerShell modules
- ExchangeOnlineManagement PowerShell module
- a browser usable by Python `zendriver` for device-code login automation

## Device-Code Authentication

### Microsoft Graph Login

```powershell
Connect-MgGraph -UseDeviceCode -NoWelcome -ContextScope Process -Scopes @(
  "User.ReadWrite.All",
  "Directory.AccessAsUser.All",
  "Domain.ReadWrite.All",
  "Policy.Read.All",
  "Policy.ReadWrite.ConditionalAccess"
)
```

This prints a device-code prompt to PowerShell output.

Typical output includes a code like:

```text
To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code ABCDEFGHI to authenticate.
```

The provisioner should capture the code, open `https://microsoft.com/devicelogin`, enter the code, then complete login with the tenant admin email and password.

### Exchange Online Login

```powershell
Connect-ExchangeOnline -Device -ShowBanner:$false
```

This also emits a device code.

Complete it through the same browser automation flow.

Both Graph and Exchange must be authenticated because the workflows use both Graph cmdlets and Exchange Online cmdlets.

## Capturing Device Codes

PowerShell output should be read while the auth command is running.

Useful regex patterns:

```regex
code ([A-Z0-9]{9})
enter the code ([A-Z0-9-]+)
device code is:? ([A-Z0-9-]+)
Code: ([A-Z0-9-]+)
```

Keep reading process output until one of these patterns matches or a timeout is reached.

Practical timeout: 60 seconds.

## Browser Automation Logic

The browser automation only completes the generic Microsoft device-login flow.

High-level logic:

```text
open https://microsoft.com/devicelogin
wait for code input
click Next
wait for email input
type admin email
click Next
wait for password input
type password
click Next
handle consent or continue prompts if present
close browser
```

For Graph login, Microsoft may show an application consent prompt. Accept it if present.

For Exchange login, the flow may only require a final continue/confirm button.

## Session Validation Cmdlets

### Check Graph Session

```powershell
Get-MgContext -ErrorAction SilentlyContinue
```

Useful fields:

```powershell
$context.Account
$context.TenantId
$context.Scopes
```

The account should match the expected tenant admin email if available.

### Check Exchange Session

```powershell
Get-ConnectionInformation -ErrorAction SilentlyContinue | Select-Object -First 1
```

Useful fields:

```powershell
$connection.UserPrincipalName
$connection.State
$connection.TokenStatus
```

The user principal name should match the expected tenant admin email if available.

### Smoke Test Both Connections

```powershell
Get-MgUser -Top 1 | Out-Null
Get-EXORecipient -ResultSize 1 | Out-Null
```

If these succeed, both Microsoft Graph and Exchange Online are usable.

## Raw Microsoft Domain Cmdlets

### List Domains

```powershell
Get-MgDomain -All |
  Select-Object Id, IsDefault, IsInitial, IsVerified, AuthenticationType, SupportedServices
```

Lists all domains registered in the tenant.

### Get Domain

```powershell
Get-MgDomain -DomainId "example.com" -ErrorAction SilentlyContinue
```

Checks whether a specific domain exists.

### Add Domain

```powershell
New-MgDomain -Id "example.com" -ErrorAction Stop
```

Adds a custom domain to Microsoft 365.

### Get Domain Verification DNS Record

```powershell
Get-MgDomainVerificationDnsRecord -DomainId "example.com" -ErrorAction Stop
```

Returns the TXT record Microsoft requires for domain verification.

Usually contains:

```text
MS=ms12345678
```

### Confirm Domain

```powershell
Confirm-MgDomain -DomainId "example.com" -ErrorAction Stop
```

Verifies the domain after the TXT record has propagated in DNS.

### Get Microsoft Service DNS Records

```powershell
Get-MgDomainServiceConfigurationRecord -DomainId "example.com" -ErrorAction Stop
```

Returns Microsoft-recommended DNS records for services such as Exchange Online.

### Remove Domain

```powershell
Remove-MgDomain -DomainId "example.com" -Confirm:$false -ErrorAction Stop
```

Removes a custom domain from the tenant.

This generally fails if users, mailboxes, aliases, or services still depend on the domain.

## Raw DKIM Cmdlets

### Get DKIM Config

```powershell
Get-DkimSigningConfig -Identity "example.com" -ErrorAction SilentlyContinue
```

Reads DKIM state for the domain.

Important fields:

```powershell
$config.Selector1CNAME
$config.Selector2CNAME
$config.Enabled
```

### Create DKIM Config

```powershell
New-DkimSigningConfig -DomainName "example.com" -Enabled:$false -ErrorAction Stop
```

Creates DKIM signing configuration and generates selector CNAME targets.

### Enable DKIM

```powershell
Set-DkimSigningConfig -Identity "example.com" -Enabled:$true -ErrorAction Stop
```

Enables DKIM signing after selector CNAME records exist in DNS.

## Raw Shared Mailbox Cmdlets

### Enable SMTP Client Authentication

```powershell
Set-TransportConfig -SmtpClientAuthenticationDisabled $false
```

Tenant-wide Exchange setting. Use carefully because this changes tenant-wide behavior.

### Check Mailbox

```powershell
Get-Mailbox -Identity "user@example.com" -ErrorAction SilentlyContinue
```

Checks whether a mailbox exists.

### Create Shared Mailbox

```powershell
New-Mailbox -Shared `
  -Name "john.smith" `
  -DisplayName "John Smith" `
  -PrimarySmtpAddress "john.smith@example.com"
```

Creates a shared mailbox.

### Get Backing Directory Object

```powershell
$mailbox = Get-Mailbox -Identity "john.smith@example.com" -ErrorAction Stop
$objectId = $mailbox.ExternalDirectoryObjectId
```

Gets the Entra ID object ID for the mailbox's backing user.

### Check Backing Graph User

```powershell
Get-MgUser -UserId $objectId -ErrorAction Stop
```

New mailboxes may take time before the Graph user is available.

### Set Password And Enable Login

```powershell
$passwordProfile = @{
  Password = "PlainTextPasswordHere"
  ForceChangePasswordNextSignIn = $false
}

Update-MgUser `
  -UserId $objectId `
  -PasswordProfile $passwordProfile `
  -AccountEnabled:$true
```

This makes the shared mailbox's backing account login-capable.

## Raw Mailbox Deletion Cmdlets

### Remove Mailbox Permanently

```powershell
Remove-Mailbox `
  -Identity "john.smith@example.com" `
  -Permanent $true `
  -Confirm:$false `
  -ErrorAction Stop
```

Permanently removes the Exchange mailbox.

### Remove Backing Graph User

```powershell
Remove-MgUser -UserId $user.Id -ErrorAction Stop
```

Deletes the Entra ID user.

### Purge Deleted Directory Object

```powershell
Remove-MgDirectoryDeletedItem -DirectoryObjectId $objectId -ErrorAction Stop
```

Purges the deleted user object from deleted items.

This helps free the address/object for reuse.

## Practical Microsoft DNS Knowledge

For a domain like `example.com`, typical Microsoft 365 mail DNS records are:

```text
MX example.com -> example-com.mail.protection.outlook.com
CNAME autodiscover.example.com -> autodiscover.outlook.com
TXT example.com -> v=spf1 include:spf.protection.outlook.com -all
TXT example.com -> MS=ms12345678
```

Recommended DMARC starter record:

```text
TXT _dmarc.example.com -> v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com; ruf=mailto:dmarc-reports@example.com; fo=1; sp=none; aspf=r; adkim=r
```

DKIM records come from `Get-DkimSigningConfig`:

```text
CNAME selector1._domainkey.example.com -> <Selector1CNAME>
CNAME selector2._domainkey.example.com -> <Selector2CNAME>
```

## Typical Domain Setup Flow

```text
1. Ensure tenant has encrypted Microsoft admin credentials.
2. Get or create tenant-scoped PowerShell session.
3. Authenticate Microsoft Graph if needed.
4. Authenticate Exchange Online if needed.
5. Check whether the domain already exists.
6. Add the domain if missing.
7. Fetch Microsoft verification DNS record.
8. Add verification, MX, SPF, autodiscover, and DMARC DNS records externally.
9. Confirm the domain in Microsoft 365.
10. Create or read DKIM signing configuration.
11. Add DKIM selector CNAMEs externally.
12. Enable DKIM.
```

## Typical Shared Mailbox Creation Flow

```text
1. Ensure tenant has encrypted Microsoft admin credentials.
2. Get or create tenant-scoped PowerShell session.
3. Authenticate Microsoft Graph and Exchange Online if needed.
4. Confirm the custom domain exists and is verified.
5. Optionally enable SMTP client authentication.
6. Create shared mailbox.
7. Wait for the backing Graph user to become available.
8. Set password on the backing user.
9. Enable the backing user account.
10. Store mailbox email, password, status, and object ID.
```

## Typical Cleanup Flow

```text
1. Ensure tenant has encrypted Microsoft admin credentials.
2. Get or create tenant-scoped PowerShell session.
3. Authenticate Microsoft Graph and Exchange Online if needed.
4. Find mailbox by email.
5. Capture ExternalDirectoryObjectId if available.
6. Remove mailbox permanently.
7. Find backing Graph user by object ID or email.
8. Remove Graph user.
9. Purge deleted directory object.
10. Verify mailbox and user no longer exist.
11. Remove custom domain only after dependencies are gone.
```

## Practical Microsoft Notes

Microsoft 365 operations are eventually consistent.

Expect retries around:

- domain verification
- mailbox creation
- Graph user availability after mailbox creation
- DKIM selector generation
- DKIM enablement
- domain removal
- mailbox/user deletion verification

Suggested retry behavior:

- Domain verification: retry every 10 seconds for a few minutes.
- DKIM selector availability: retry every 15 seconds for several minutes.
- Backing Graph user after mailbox creation: retry every 5 seconds for about a minute.
- After deleting mailbox/user: wait briefly before verifying deletion.

PowerShell output is noisy. When returning structured data from PowerShell, wrap JSON in explicit markers:

```powershell
Write-Host "__RESULT_START__"
$data | ConvertTo-Json -Depth 8 -Compress
Write-Host "__RESULT_END__"
```

Then parse only the text between the markers.

Use `-ErrorAction Stop` for operations that must fail loudly.

Use `-ErrorAction SilentlyContinue` only for existence checks where absence is acceptable.

## Deferred Decisions

The following decisions are intentionally deferred:

- exact plan names and prices
- exact active tenant slot counts per plan
- exact global/org concurrency numbers
- exact workspace permission roles
- exact admin/support UI shape
- exact credit ledger implementation
- exact backup tooling/provider
- exact monitoring provider
- exact shadcn/ui theme/components
- exact Python provisioner request/response payloads
- exact public API surface
- exact internal docs structure
