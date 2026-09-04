# Real Tenant Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development or execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the tenant-validation command into a real, idempotent Microsoft tenant
authentication workflow that creates and retains one reusable PowerShell session per tenant
connection.

**Architecture:** The existing public API continues to create a credential-free durable job
and return `202`. One TypeScript worker process admits at most three active Microsoft attempts
per organization and five globally, decrypts credentials immediately before a signed private
request, and applies only safe provisioner results. One Python provisioner instance owns
Zendriver, persistent PowerShell process groups, and an in-memory registry keyed by tenant
connection ID; it reauthenticates transparently before an action when a session is missing or
unhealthy.

**Tech Stack:** TypeScript, Hono, Drizzle/Postgres, pg-boss, Zod, Python 3.12, FastAPI,
Uvicorn, Zendriver, Chromium, PowerShell 7, Microsoft.Graph PowerShell, and
ExchangeOnlineManagement.

---

## Frozen Decisions

- Public Microsoft commands return an idempotent job with only `processing`, `completed`, and
  `failed`; capacity waiting, retries, authentication, and reauthentication stay internal.
- Each tenant connection owns a distinct email/password credential identity and isolated
  PowerShell process group. Sessions never cross tenant-connection boundaries.
- One tenant connection has one active Microsoft job. Different tenant connections may run
  concurrently.
- Sessions have a 60-minute idle TTL. Successful authenticated health checks and Microsoft
  actions reset `lastUsedAt`. Before every action, verify Graph, Exchange, tenant ID, and the
  signed-in UPN; kill and replace an unhealthy session before the action begins.
- One worker process and one provisioner instance run on the private Docker network. The
  worker admits three active Microsoft attempts per organization and five globally. Retry
  delays hold no capacity. Zendriver authentication has one global permit.
- Development runs the Python service natively with a visible browser. Production runs the
  same service in Docker with `PROVISIONER_HEADLESS=true` and no published provisioner port.
- Initial authentication requests Graph scopes `User.ReadWrite.All`,
  `Directory.AccessAsUser.All`, `Domain.ReadWrite.All`, `Policy.Read.All`, and
  `Policy.ReadWrite.ConditionalAccess`, then connects Exchange using device code in the same
  PowerShell process. This slice contains no command that changes Conditional Access or
  security defaults.
- Do not retry a Microsoft create/update whose outcome is unknown after a mid-command failure.
  That operation-specific reconciliation is deferred with domain and inbox commands.

## File Map

| Path                                          | Responsibility                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/db/src/schema/product.ts`           | Durable job availability used by retries and capacity recovery.                            |
| `packages/db/src/migrations/0007_*.sql`       | Forward-only job availability migration.                                                   |
| `packages/product/src/tenant-credentials.ts`  | AES-GCM encryption/decryption with tenant-validation AAD.                                  |
| `packages/product/src/tenant-validation.ts`   | Strict lease fence and durable retry eligibility.                                          |
| `apps/worker/src/microsoft-work-limiter.ts`   | In-process organization/global attempt admission.                                          |
| `apps/worker/src/provisioner-client.ts`       | Signed HTTP implementation of `TenantValidationProvisioner`.                               |
| `apps/worker/src/tenant-validation-worker.ts` | Capacity-aware job execution, renewal, and safe result application.                        |
| `apps/worker/src/main.ts`                     | Real worker composition and graceful shutdown.                                             |
| `apps/provisioner/`                           | Python service, request verification, session registry, browser, and PowerShell ownership. |
| `docker-compose*.yml`                         | One worker and one private provisioner deployment.                                         |
| `docs/`                                       | Canonical session, capacity, security, and roadmap decisions.                              |

### Task 1: Harden Durable Tenant-Validation Scheduling

**Files:**

- Modify: `packages/db/src/schema/product.ts`
- Create: `packages/db/src/migrations/0007_greedy_praxagora.sql`
- Modify: `packages/product/src/tenant-validation.ts`
- Modify: `packages/product/test/integration/tenant-validation.test.ts`

- [ ] **Step 1: Add failing lease-boundary and retry-eligibility tests.**

```ts
expect(await renewTenantValidationJobLease(database, jobId, leaseToken, expiresAt)).toEqual({
  status: "not_renewed",
});

expect(await claimTenantValidationJob(database, retryableJob.id, retryDueAt)).toEqual({
  status: "not_claimed",
});
```

- [ ] **Step 2: Run the focused Product integration suite.**

Run: `TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/inbox-saas-test pnpm --filter @inbox-saas/product test:integration`

Expected: the new boundary tests fail because equality is currently accepted and only the
outbox event has delayed eligibility.

- [ ] **Step 3: Add `job.availableAt` with `now()` default and generate the forward migration.**

```ts
availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
```

Run: `pnpm db:generate`

Review the generated migration. It must add a non-null timestamp defaulted to `now()`; do not
handwrite a rollback migration.

- [ ] **Step 4: Make claim, recovery, and retry transitions use job availability.**

```ts
and(eq(job.state, "queued"), lte(job.availableAt, now));
```

On retryable failure, set both `job.availableAt` and the replacement outbox event
`availableAt` to the same calculated retry time. Recovery makes a reclaimable job available
immediately. Use `gt(job.leaseExpiresAt, now)` for renew/apply ownership and `lte` for expiry
reclaim so an exactly expired token never succeeds.

- [ ] **Step 5: Rerun the focused suite.**

Run: `TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/inbox-saas-test pnpm --filter @inbox-saas/product test:integration`

Expected: PASS, including exact-expiry, early-retry, and recovered-job cases.

### Task 2: Bind Encrypted Credentials to Their Tenant Context

**Files:**

- Modify: `packages/product/src/tenant-credentials.ts`
- Modify: `packages/product/test/unit/tenant-credentials.test.ts`
- Modify: `packages/product/test/integration/tenant-validation.test.ts`

- [ ] **Step 1: Write a failing ciphertext-transplant test.**

```ts
expect(() =>
  cipher.decrypt(encryptedForWorkspaceA, {
    operation: "tenant_validation",
    workspaceId: workspaceB,
  }),
).toThrow();
```

- [ ] **Step 2: Add canonical AES-GCM additional authenticated data.**

```ts
function tenantCredentialAad(context: TenantCredentialContext): Buffer {
  return Buffer.from(
    JSON.stringify({ operation: context.operation, workspaceId: context.workspaceId }),
    "utf8",
  );
}
```

Pass this buffer to `cipher.setAAD(...)` before encryption and decipher initialization. Keep the
same context required at every Product call site; do not add a no-AAD fallback.

- [ ] **Step 3: Run credential and tenant-validation tests.**

Run: `pnpm --filter @inbox-saas/product test:unit`

Run: `TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/inbox-saas-test pnpm --filter @inbox-saas/product test:integration`

Expected: PASS. The wrong workspace and wrong operation cannot decrypt a valid ciphertext.

### Task 3: Make the Fake Vertical Runnable Locally

**Files:**

- Modify: `apps/worker/src/main.ts`
- Modify: `apps/worker/src/runtime-config.ts`
- Modify: `apps/worker/test/unit/runtime-config.test.ts`
- Modify: `apps/worker/test/integration/tenant-validation-worker.test.ts`
- Modify: `apps/worker/package.json`
- Modify: `docker-compose.dev.yml`

- [ ] **Step 1: Add a local worker service/script test that submits an API-created job through pg-boss.**

```ts
await createTenantValidationWorker({
  database,
  databaseUrl: testDatabaseUrl,
  cipher,
  credentialKeyVersion: "test-v1",
  provisioner: new FakeTenantValidationProvisioner(successResult),
});
```

Assert the job created through `startTenantValidation` reaches `completed` without invoking the
worker test helper directly.

- [ ] **Step 2: Add the smallest development runner configuration.**

Keep the fake provisioner development-only and retain the production refusal. Add documented
development environment names and a Compose `worker` service only when
`TENANT_VALIDATION_PROVISIONER=fake`; never make a fake production path possible.

- [ ] **Step 3: Run the worker integration suite.**

Run: `TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/inbox-saas-test pnpm --filter worker test:integration`

Expected: PASS and the API-created job reaches its safe terminal DTO.

### Task 4: Define the Signed Private Provisioner Transport

**Files:**

- Modify: `packages/provisioner-contract/src/index.ts`
- Create: `apps/worker/src/provisioner-request-auth.ts`
- Create: `apps/worker/src/provisioner-client.ts`
- Create: `apps/worker/test/unit/provisioner-request-auth.test.ts`
- Create: `apps/worker/test/unit/provisioner-client.test.ts`

- [ ] **Step 1: Extend the contract with transport-neutral request metadata and validated safe results.**

```ts
export const provisionerRequestSchema = z.strictObject({
  contractVersion: provisionerContractVersionSchema,
  jobId: z.string().min(1),
  tenantConnectionId: z.string().min(1),
  credentials: tenantAdminCredentialsSchema,
});
```

Do not put a device code, browser state, PowerShell command, raw exception, or secret in a
contract result. Keep the current `TenantValidationProvisioner` interface so the fake and HTTP
clients remain substitutable.

- [ ] **Step 2: Test canonical request signing before implementing the client.**

```ts
expect(signProvisionerRequest(secret, timestamp, nonce, body)).toBe(expectedSignature);
expect(verifyProvisionerResponse(invalidJson)).toThrow();
```

Use HMAC-SHA-256 over an explicit newline-delimited canonical input:
`timestamp + "\n" + nonce + "\n" + SHA-256(rawBody)`. Headers are `X-Inbox-Timestamp`,
`X-Inbox-Nonce`, and `X-Inbox-Signature`.

- [ ] **Step 3: Implement the HTTP client.**

```ts
const response = await fetch(`${baseUrl}/internal/v1/tenant-validations`, {
  method: "POST",
  headers: signedHeaders,
  body: JSON.stringify(request),
  signal: AbortSignal.timeout(timeoutMs),
});
return tenantValidationResultSchema.parse(await response.json());
```

Reject all non-2xx, malformed JSON, and schema-invalid responses as retryable worker-side
infrastructure failures. Never log the request body or response body.

- [ ] **Step 4: Run worker and contract tests.**

Run: `pnpm --filter @inbox-saas/provisioner-contract test:unit`

Run: `pnpm --filter worker test:unit`

Expected: PASS, including deterministic signature, timeout, malformed response, and no-secret
logging tests.

### Task 5: Create the Private Python Service and Request Verification

**Files:**

- Create: `apps/provisioner/pyproject.toml`
- Create: `apps/provisioner/src/inbox_provisioner/settings.py`
- Create: `apps/provisioner/src/inbox_provisioner/contracts.py`
- Create: `apps/provisioner/src/inbox_provisioner/request_auth.py`
- Create: `apps/provisioner/src/inbox_provisioner/app.py`
- Create: `apps/provisioner/tests/test_request_auth.py`
- Create: `apps/provisioner/tests/test_app.py`

- [ ] **Step 1: Write request-verification tests.**

```python
def test_rejects_replayed_nonce(client, signed_headers, request_body):
    assert client.post(PATH, json=request_body, headers=signed_headers).status_code == 202
    assert client.post(PATH, json=request_body, headers=signed_headers).status_code == 401
```

Cover missing signature, invalid signature, timestamp outside a five-minute window, duplicate
nonce, malformed body, and unknown fields.

- [ ] **Step 2: Implement strict Pydantic request/result models and HMAC verification.**

```python
canonical = f"{timestamp}\n{nonce}\n{sha256(raw_body).hexdigest()}".encode()
expected = hmac.new(secret, canonical, hashlib.sha256).hexdigest()
if not hmac.compare_digest(signature, expected):
    raise HTTPException(status_code=401)
```

Keep a bounded in-memory nonce cache expiring entries after five minutes. This is correct for
the single initial provisioner instance. Bind the server to its Docker network interface, and
publish no host port in production.

- [ ] **Step 3: Add a health endpoint and the validation endpoint shell.**

`GET /healthz` returns no secret detail. `POST /internal/v1/tenant-validations` verifies the
envelope, validates the body, calls a service object, and returns only the existing safe
result schema. Tests use a fake service; no browser or PowerShell is required for HTTP tests.

- [ ] **Step 4: Run Python tests and static checks.**

Run: `uv run --directory apps/provisioner pytest`

Run: `uv run --directory apps/provisioner ruff check .`

Expected: PASS.

### Task 6: Implement Persistent PowerShell Session Ownership

**Files:**

- Create: `apps/provisioner/src/inbox_provisioner/powershell.py`
- Create: `apps/provisioner/src/inbox_provisioner/session_registry.py`
- Create: `apps/provisioner/tests/test_session_registry.py`
- Create: `apps/provisioner/tests/test_powershell.py`

- [ ] **Step 1: Write registry tests using a fake process factory and clock.**

```python
async def test_expired_session_is_stopped_then_replaced():
    await registry.ensure(connection_id, credentials)
    clock.advance(minutes=61)
    await registry.ensure(connection_id, credentials)
    assert old_process.stopped is True
```

Also cover: connection IDs never share handles, unhealthy Graph/Exchange checks replace the
process, successful use resets idle time, credential invalidation stops the process, and an
in-flight session cannot be expired.

- [ ] **Step 2: Build a process-group wrapper with framed commands.**

Start `pwsh` in a new process group. Send only fixed internal scripts, each wrapped with a
marker derived from that command's UUID and containing one JSON result line. Read until that
marker or a fixed timeout. Never accept caller-supplied PowerShell and never return raw
stdout; redact command output from logs.

- [ ] **Step 3: Build `SessionRegistry.ensure`.**

```python
session = await registry.get(connection_id)
if session and await session.health_check(expected_email):
    session.touch(clock.now())
    return session
await registry.dispose(connection_id)
return await registry.authenticate_and_register(connection_id, credentials)
```

Authentication must verify Graph, Exchange, Microsoft tenant ID, and that the signed-in UPN
case-insensitively equals the submitted email. It stores only process handles, verified
identity, and timestamps. It never stores credentials, browser profiles, cookies, device
codes, or tokens.

- [ ] **Step 4: Run isolated Python session tests.**

Run: `uv run --directory apps/provisioner pytest tests/test_session_registry.py tests/test_powershell.py`

Expected: PASS with no real Microsoft dependency.

### Task 7: Implement Zendriver and Microsoft Tenant Validation

**Files:**

- Create: `apps/provisioner/src/inbox_provisioner/device_code.py`
- Create: `apps/provisioner/src/inbox_provisioner/tenant_validation.py`
- Create: `apps/provisioner/tests/test_tenant_validation.py`
- Modify: `apps/provisioner/src/inbox_provisioner/app.py`

- [ ] **Step 1: Test failure classification around a fake PowerShell/browser driver.**

```python
assert await service.validate(request) == failure("authentication_challenge", retryable=False)
assert await service.validate(request) == failure("microsoft_unavailable", retryable=True)
```

Cover invalid credentials, unsupported MFA/Conditional Access/CAPTCHA/risk prompts, device
code timeout, PowerShell startup failure, and safe successful tenant-ID discovery.

- [ ] **Step 2: Implement one global Zendriver permit and short-lived browser lifecycle.**

```python
async with browser_limiter:
    browser = await zendriver.start(headless=settings.headless)
    try:
        await complete_device_login(browser, device_code, credentials)
    finally:
        await browser.stop()
```

Use a fresh temporary profile. Do not disable Chromium sandboxing. Browser/device-code data
must never cross the typed service boundary or enter logs.

- [ ] **Step 3: Authenticate both Microsoft surfaces in one PowerShell process.**

Issue a fixed `Connect-MgGraph -UseDeviceCode -ContextScope Process` command with the frozen
Graph scope array, parse only the internal device-code event, complete it, then issue fixed
`Connect-ExchangeOnline -Device -ShowBanner:$false` in the same process and complete its
device-code flow. Verify both connections before registering the session.

- [ ] **Step 4: Run Python unit tests.**

Run: `uv run --directory apps/provisioner pytest tests/test_tenant_validation.py`

Expected: PASS. Unsupported interactive challenges become safe non-retryable results.

### Task 8: Add Worker Admission and Real Provisioner Composition

**Files:**

- Create: `apps/worker/src/microsoft-work-limiter.ts`
- Create: `apps/worker/test/unit/microsoft-work-limiter.test.ts`
- Modify: `apps/worker/src/tenant-validation-worker.ts`
- Modify: `apps/worker/src/runtime-config.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/worker/test/integration/tenant-validation-worker.test.ts`

- [ ] **Step 1: Write deterministic limiter tests.**

```ts
expect(limiter.tryAcquire({ organizationId: "org-a" })).toBeDefined();
expect(limiter.tryAcquire({ organizationId: "org-a" })).toBeDefined();
expect(limiter.tryAcquire({ organizationId: "org-a" })).toBeDefined();
expect(limiter.tryAcquire({ organizationId: "org-a" })).toBeUndefined();
```

Also prove five total permits block a sixth organization, `release()` wakes a waiter, and a
retry delay does not retain a permit.

- [ ] **Step 2: Admit work before the private provisioner attempt and renew leases while waiting.**

The worker gets the job's organization from Product-owned data, waits internally for a limiter
permit, then starts/renews the lease for the real attempt. On cancellation, terminal result,
or transient-failure scheduling, release the permit in `finally`. Do not add a public state or
expose a capacity error.

- [ ] **Step 3: Replace production fake composition with explicit real configuration.**

```ts
const provisioner = new HttpTenantValidationProvisioner({
  baseUrl: config.provisionerBaseUrl,
  serviceSecret: config.provisionerServiceSecret,
});
```

Require production `PROVISIONER_BASE_URL` and `PROVISIONER_SERVICE_SECRET`. Keep a separate
development fake entrypoint for the fake vertical; do not select fake behavior via a
production fallback.

- [ ] **Step 4: Run worker tests.**

Run: `pnpm --filter worker test:unit`

Run: `TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/inbox-saas-test pnpm --filter worker test:integration`

Expected: PASS, including capacity invisibility, permit release, HTTP safe result handling,
and worker lease renewal during a slow provisioner call.

### Task 9: Package and Wire the Single-VPS Runtime

**Files:**

- Create: `apps/provisioner/Dockerfile`
- Create: `apps/provisioner/.env.example`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.dev.yml`
- Modify: `docker-compose.production.yml`
- Modify: `apps/worker/.env.example`
- Modify: `README.md` if it contains local runtime commands

- [ ] **Step 1: Add a production provisioner image.**

Install Python, Chromium, `pwsh`, Microsoft.Graph PowerShell modules, and
ExchangeOnlineManagement in the image. Run a non-root service user. Declare a health check
against `/healthz`; publish no provisioner port.

- [ ] **Step 2: Add one real worker and provisioner Compose service.**

```yaml
worker:
  depends_on:
    provisioner:
      condition: service_healthy
  restart: unless-stopped

provisioner:
  expose: ["8000"]
  restart: unless-stopped
```

Production requires the credential-encryption key, key version, provisioner URL, and service
secret. Both services depend on completed migrations. Do not expose `8000` with `ports`.

- [ ] **Step 3: Add native headful development commands.**

Document `PROVISIONER_HEADLESS=false uv run ... uvicorn ...` for the host provisioner and the
matching local worker environment pointing at it. The developer machine owns the visible
Chromium window. Production sets `PROVISIONER_HEADLESS=true`.

- [ ] **Step 4: Build and smoke-test Compose.**

Run: `pnpm docker:build`

Run: `docker compose -f docker-compose.yml -f docker-compose.dev.yml config`

Expected: images build and the rendered provisioner service has no host port mapping.

### Task 10: Controlled Microsoft Tenant Pilot

**Files:**

- Create: `apps/provisioner/tests/manual/tenant-validation-pilot.md`
- Modify: `docs/implementation/next.md`
- Modify: `docs/architecture/operations.md`

- [ ] **Step 1: Record the redacted pilot procedure.**

The procedure uses a dedicated non-production Microsoft 365 tenant and test admin supplied
outside Git. It verifies a first validation, safe public job result, discovered tenant ID,
session reuse on a second validation/action health check, forced process disposal, automatic
reauthentication, and 60-minute idle expiry. It must not record credentials, device codes,
tokens, cookies, or raw PowerShell output.

- [ ] **Step 2: Run the local end-to-end pilot.**

Start Postgres, server, native provisioner with `PROVISIONER_HEADLESS=false`, and real worker.
Submit the existing idempotent tenant-validation endpoint once. Repeat the same request with
the same idempotency key and verify it returns the original job. Poll only `GET /api/v1/jobs/:jobId`.

- [ ] **Step 3: Verify session behavior.**

Confirm the second authenticated internal use reuses the exact tenant-connection session;
then stop it or advance the test clock, submit work, and confirm a replacement session is
created before action. Confirm a tenant mismatch, UPN mismatch, or MFA/Conditional Access
challenge returns only the documented safe failure result.

- [ ] **Step 4: Run full repository verification and record completion.**

Run: `pnpm check`

Run: `pnpm check-types`

Run: `pnpm test`

Run: `pnpm test:unit`

Run: `TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/inbox-saas-test pnpm test:integration`

Run: `git diff --check`

Update the roadmap only after the automated suite and controlled pilot both pass.

## Plan Review

- Spec coverage: Tasks 1-3 complete the fake-backed durable vertical. Tasks 4-9 implement
  the signed private transport, one worker/provisioner topology, capacity limits, one-browser
  authentication, persistent isolated sessions, development headful mode, and production
  headless Docker mode. Task 10 proves the tenant-authentication path with a controlled tenant.
- Deliberately deferred: domain and inbox commands, operation-specific partial-success
  reconciliation, distributed admission/session affinity, public queue status, persisted
  browser/token/session state, manual interactive authentication handoff, and policy mutation.
- Consistency: all public wait states remain `processing`; capacity is per organization and
  globally enforced by the single worker; sessions are keyed only by tenant connection and are
  never durable.
