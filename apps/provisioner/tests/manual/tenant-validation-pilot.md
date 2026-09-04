# Tenant-Validation Pilot Runbook

Controlled manual verification of real Microsoft tenant authentication against a dedicated
non-production Microsoft 365 tenant. Automated tests cover signing, replay protection,
transport encryption, session registry, retries, and leases with fakes; only this pilot can
confirm live Microsoft behavior.

**Never record in this file or any ticket:** tenant-admin passwords, device codes, tokens,
cookies, raw PowerShell output, or the pilot tenant's real identifiers. Use placeholders such
as `<pilot-tenant-id>` in filled-in results.

## Prerequisites

- Dedicated non-production Microsoft 365 tenant with a test global-admin account that has no
  MFA, Conditional Access, CAPTCHA, risk, or security-default challenges enabled.
- Local Postgres running (`pnpm db:start`) with migrations applied.
- Generated secrets (do not commit):

  ```bash
  openssl rand -base64 32   # TENANT_CREDENTIAL_ENCRYPTION_KEY
  openssl rand -base64 32   # INBOX_PROVISIONER_SIGNING_SECRET
  openssl rand -base64 32   # INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY
  ```

## Steps

### 1. Start the native headful provisioner

```bash
cd apps/provisioner
INBOX_PROVISIONER_SIGNING_SECRET=<base64> \
INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY=<base64> \
INBOX_PROVISIONER_HEADLESS_BROWSER=false \
uv run uvicorn inbox_provisioner.main:app --host 127.0.0.1 --port 8000
```

Watch the browser window during every authentication step. Note any screen the automation
handles that is not a plain email/password/consent/continue screen.

### 2. Start the real worker

```bash
cd apps/worker
DATABASE_URL=postgresql://postgres:password@localhost:5432/inbox-saas \
TENANT_CREDENTIAL_ENCRYPTION_KEY=<base64> \
TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION=pilot-v1 \
PROVISIONER_BASE_URL=http://127.0.0.1:8000 \
INBOX_PROVISIONER_SIGNING_SECRET=<base64> \
INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY=<base64> \
pnpm dev
```

### 3. Submit the first validation through the public API

Use an existing organization API key (create one directly in the database if issuance UI is
not available yet) and a unique `Idempotency-Key`:

```bash
curl -i -X POST http://localhost:3000/api/v1/workspaces/<workspace-id>/tenant-connections \
  -H "Authorization: Bearer <api-key>" \
  -H "Idempotency-Key: pilot-001" \
  -H "Content-Type: application/json" \
  -d '{"credentials":{"email":"<pilot-admin>@<tenant>.onmicrosoft.com","password":"<redacted>"}}'
```

Expected: `202` with `job.status` of `processing` and no lease/attempt/capacity fields.

### 4. Poll to terminal state

```bash
curl -s http://localhost:3000/api/v1/jobs/<job-id> -H "Authorization: Bearer <api-key>"
```

Expected: `completed`; `tenantConnection.microsoftTenantId` equals `<pilot-tenant-id>`.
Record wall-clock duration of the first authentication (budget: 240s hard limit).

### 5. Verify idempotent replay

Repeat step 3 with the same `Idempotency-Key` and identical payload. Expected: the same job
resource, no new Microsoft authentication in the browser.

### 6. Verify session reuse

Submit a second validation for the same tenant connection (new `Idempotency-Key`, same
credentials). Expected: no new browser authentication; the provisioner reuses the live
session after its health check and the job completes noticeably faster than step 4.

### 7. Verify transparent reauthentication

Restart the provisioner process (drops all in-memory sessions), then submit another
validation. Expected: exactly one new browser authentication, then job completion — the
client saw only `processing` throughout.

### 8. Verify safe failures

- Wrong password: expected public failure `invalid_credentials`, non-retryable, no Microsoft
  detail in the response.
- A second tenant connection in the same workspace using credentials of a different admin
  whose UPN does not case-insensitively match its submitted email: expected retryable
  failure, and the provisioner must discard the mismatched session.

If the pilot tenant can temporarily enable MFA on the test admin, verify the
`authentication_challenge` non-retryable classification, then re-disable it.

### 9. Record results

Fill in: date, first-auth duration, reuse duration, which Microsoft screens appeared, any
selector/wording mismatches observed in the browser, and each expected/actual outcome above.
File issues for any mismatch before closing the tenant-validation slice.

## Out Of Scope For This Pilot

Domain setup, inbox creation/deletion, mid-command partial-success reconciliation, and any
Conditional Access or security-default mutation.
