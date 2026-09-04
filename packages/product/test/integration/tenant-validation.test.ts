import {
  accessGrant,
  createDb,
  idempotencyRecord,
  job,
  organization,
  outboxEvent,
  tenantConnection,
  user,
  workspace,
} from "@inbox-saas/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyTenantValidationResult,
  claimTenantValidationJob,
  createTenantCredentialCipher,
  getTenantValidationJob,
  recoverExpiredTenantValidationJobs,
  renewTenantValidationJobLease,
  startTenantValidation,
} from "../../src/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.includes("test")) {
  throw new Error("TEST_DATABASE_URL must point to an isolated test database");
}

const database = createDb(testDatabaseUrl);
const cipher = createTenantCredentialCipher({ key: Buffer.alloc(32, 7), keyVersion: "test-v1" });

let userId: string;
let organizationOneId: string;
let organizationTwoId: string;
let workspaceOneId: string;
let workspaceOneOtherId: string;
let workspaceTwoId: string;

const credentials = { email: "tenant-admin@example.test", password: "private-password" };

async function claimJob(jobId: string, now?: Date) {
  if (now) {
    await database.update(job).set({ availableAt: now }).where(eq(job.id, jobId));
  }
  const claimed = await claimTenantValidationJob(database, jobId, now);
  if (claimed.status !== "claimed" || !claimed.job.leaseToken) {
    throw new Error("Expected tenant validation job to be claimed");
  }
  return { ...claimed, job: { ...claimed.job, leaseToken: claimed.job.leaseToken } };
}

function organizationWriteGrant() {
  return [
    {
      organizationId: organizationOneId,
      permission: "write" as const,
      scope: "organization" as const,
    },
  ];
}

function workspaceWriteGrant() {
  return [
    {
      organizationId: organizationOneId,
      permission: "write" as const,
      scope: "workspace" as const,
      workspaceId: workspaceOneId,
    },
  ];
}

beforeEach(async () => {
  const suffix = crypto.randomUUID();
  userId = `tenant-validation-user-${suffix}`;

  await database.insert(user).values({
    id: userId,
    name: "Tenant Validation User",
    email: `tenant-validation-${suffix}@example.test`,
    initialOrganizationName: "Initial Tenant Validation Organization",
  });
  const initialOrganizations = await database
    .select({ organizationId: accessGrant.organizationId })
    .from(accessGrant)
    .where(eq(accessGrant.userId, userId));
  await database.delete(organization).where(
    inArray(
      organization.id,
      initialOrganizations.map((grant) => grant.organizationId),
    ),
  );

  const organizations = await database
    .insert(organization)
    .values([
      { name: "Tenant Validation Organization One" },
      { name: "Tenant Validation Organization Two" },
    ])
    .returning({ id: organization.id });
  const [organizationOne, organizationTwo] = organizations;
  if (!organizationOne || !organizationTwo) {
    throw new Error("Expected two organizations");
  }
  organizationOneId = organizationOne.id;
  organizationTwoId = organizationTwo.id;

  const workspaces = await database
    .insert(workspace)
    .values([
      { name: "Tenant Validation Workspace One", organizationId: organizationOneId },
      { name: "Tenant Validation Workspace One Other", organizationId: organizationOneId },
      { name: "Tenant Validation Workspace Two", organizationId: organizationTwoId },
    ])
    .returning({ id: workspace.id });
  const [workspaceOne, workspaceOneOther, workspaceTwo] = workspaces;
  if (!workspaceOne || !workspaceOneOther || !workspaceTwo) {
    throw new Error("Expected three workspaces");
  }
  workspaceOneId = workspaceOne.id;
  workspaceOneOtherId = workspaceOneOther.id;
  workspaceTwoId = workspaceTwo.id;
});

afterEach(async () => {
  await database
    .delete(organization)
    .where(inArray(organization.id, [organizationOneId, organizationTwoId]));
  await database.delete(user).where(eq(user.id, userId));
});

describe("tenant validation", () => {
  it("authorizes organization and matching workspace writes without revealing other workspaces", async () => {
    await expect(
      startTenantValidation(
        database,
        workspaceWriteGrant(),
        {
          credentials,
          idempotencyKey: "workspace-write",
          workspaceId: workspaceOneId,
        },
        cipher,
      ),
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(
      startTenantValidation(
        database,
        organizationWriteGrant(),
        {
          credentials,
          idempotencyKey: "organization-write",
          workspaceId: workspaceOneOtherId,
        },
        cipher,
      ),
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(
      startTenantValidation(
        database,
        workspaceWriteGrant(),
        {
          credentials,
          idempotencyKey: "denied-workspace",
          workspaceId: workspaceOneOtherId,
        },
        cipher,
      ),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      startTenantValidation(
        database,
        workspaceWriteGrant(),
        {
          credentials,
          idempotencyKey: "denied-organization",
          workspaceId: workspaceTwoId,
        },
        cipher,
      ),
    ).resolves.toEqual({ status: "not_found" });
  });

  it("atomically stores encrypted credentials and safe job records", async () => {
    const result = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "atomic-create",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") {
      return;
    }

    const [storedTenant] = await database
      .select()
      .from(tenantConnection)
      .where(eq(tenantConnection.id, result.tenantConnection.id));
    const [storedJob] = await database.select().from(job).where(eq(job.id, result.job.id));
    const [storedIdempotency] = await database
      .select()
      .from(idempotencyRecord)
      .where(eq(idempotencyRecord.jobId, result.job.id));
    const [storedOutbox] = await database
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.jobId, result.job.id));

    expect(storedTenant?.state).toBe("validating");
    expect(storedJob).toMatchObject({ operation: "tenant_validation", state: "queued" });
    expect(storedIdempotency?.payloadFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(storedOutbox).toMatchObject({
      payload: { jobId: result.job.id },
      type: "tenant_validation_requested",
    });
    expect(
      JSON.stringify([storedTenant, storedJob, storedIdempotency, storedOutbox, result]),
    ).not.toContain(credentials.email);
    expect(
      JSON.stringify([storedTenant, storedJob, storedIdempotency, storedOutbox, result]),
    ).not.toContain(credentials.password);
  });

  it("reuses equivalent organization-wide idempotency keys and safely conflicts on changed payloads", async () => {
    const first = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "same-key",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    const repeated = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "same-key",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    const changed = await startTenantValidation(
      database,
      organizationWriteGrant(),
      {
        credentials: { ...credentials, password: "changed-password" },
        idempotencyKey: "same-key",
        workspaceId: workspaceOneOtherId,
      },
      cipher,
    );

    expect(first).toMatchObject({ reused: false, status: "accepted" });
    expect(repeated).toMatchObject({ reused: true, status: "accepted" });
    if (first.status === "accepted" && repeated.status === "accepted") {
      expect(repeated.job.id).toBe(first.job.id);
    }
    expect(changed).toEqual({ status: "idempotency_conflict" });
  });

  it("denies job reads outside the granted workspace or organization", async () => {
    const started = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "read-access",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    if (started.status !== "accepted") {
      throw new Error("Expected accepted validation");
    }

    await expect(
      getTenantValidationJob(
        database,
        [
          {
            organizationId: organizationOneId,
            permission: "read",
            scope: "workspace",
            workspaceId: workspaceOneId,
          },
        ],
        started.job.id,
      ),
    ).resolves.toMatchObject({ status: "found" });
    await expect(
      getTenantValidationJob(
        database,
        [
          {
            organizationId: organizationOneId,
            permission: "read",
            scope: "workspace",
            workspaceId: workspaceOneOtherId,
          },
        ],
        started.job.id,
      ),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      getTenantValidationJob(
        database,
        [{ organizationId: organizationTwoId, permission: "read", scope: "organization" }],
        started.job.id,
      ),
    ).resolves.toEqual({ status: "not_found" });
  });

  it("applies contract results and safely fails active Microsoft tenant collisions", async () => {
    const first = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "first-result",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    const second = await startTenantValidation(
      database,
      organizationWriteGrant(),
      {
        credentials,
        idempotencyKey: "second-result",
        workspaceId: workspaceOneOtherId,
      },
      cipher,
    );
    if (first.status !== "accepted" || second.status !== "accepted") {
      throw new Error("Expected accepted validations");
    }
    const firstClaim = await claimJob(first.job.id);
    const secondClaim = await claimJob(second.job.id);

    await expect(
      applyTenantValidationResult(database, first.job.id, firstClaim.job.leaseToken, {
        contractVersion: "v1",
        microsoftTenantId: "microsoft-tenant-1",
        status: "success",
      }),
    ).resolves.toMatchObject({
      job: { leaseExpiresAt: null, state: "completed" },
      tenantConnection: { state: "active" },
    });
    await expect(
      applyTenantValidationResult(database, second.job.id, secondClaim.job.leaseToken, {
        contractVersion: "v1",
        microsoftTenantId: "microsoft-tenant-1",
        status: "success",
      }),
    ).resolves.toMatchObject({
      job: {
        failureCode: "tenant_already_connected",
        leaseExpiresAt: null,
        retryable: false,
        state: "failed",
      },
      tenantConnection: { state: "validation_failed" },
    });
    await expect(
      applyTenantValidationResult(database, second.job.id, secondClaim.job.leaseToken, {
        code: "microsoft_unavailable",
        contractVersion: "v1",
        retryable: true,
        status: "failure",
      }),
    ).resolves.toEqual({ status: "stale" });
  });

  it("claims queued jobs once until their lease expires", async () => {
    const started = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "claim-lease",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    if (started.status !== "accepted") {
      throw new Error("Expected accepted validation");
    }

    const firstClaimAt = new Date("2026-01-01T00:00:00.000Z");
    await database.update(job).set({ availableAt: firstClaimAt }).where(eq(job.id, started.job.id));
    await expect(
      claimTenantValidationJob(database, started.job.id, firstClaimAt, 60_000),
    ).resolves.toMatchObject({
      job: {
        attemptCount: 1,
        leaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
        state: "running",
      },
      status: "claimed",
    });
    await expect(
      claimTenantValidationJob(
        database,
        started.job.id,
        new Date("2026-01-01T00:00:30.000Z"),
        60_000,
      ),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      claimTenantValidationJob(
        database,
        started.job.id,
        new Date("2026-01-01T00:01:00.000Z"),
        60_000,
      ),
    ).resolves.toMatchObject({ job: { attemptCount: 2, state: "running" }, status: "claimed" });
  });

  it("requeues retryable failures through the second attempt and terminally fails the third", async () => {
    const retryable = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "retryable-failure",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    if (retryable.status !== "accepted") {
      throw new Error("Expected accepted validation");
    }

    const firstAttemptAt = new Date();
    let retryClaim = await claimJob(retryable.job.id, firstAttemptAt);
    await expect(
      applyTenantValidationResult(
        database,
        retryable.job.id,
        retryClaim.job.leaseToken,
        {
          code: "microsoft_unavailable",
          contractVersion: "v1",
          retryable: true,
          status: "failure",
        },
        firstAttemptAt,
      ),
    ).resolves.toMatchObject({
      job: {
        attemptCount: 1,
        failureCode: "microsoft_unavailable",
        leaseExpiresAt: null,
        retryable: true,
        state: "queued",
      },
      tenantConnection: { state: "validating" },
    });
    await expect(
      claimTenantValidationJob(
        database,
        retryable.job.id,
        new Date(firstAttemptAt.getTime() + 59_999),
      ),
    ).resolves.toEqual({ status: "not_found" });
    retryClaim = await claimJob(retryable.job.id, new Date(firstAttemptAt.getTime() + 60_000));
    await expect(
      applyTenantValidationResult(
        database,
        retryable.job.id,
        retryClaim.job.leaseToken,
        {
          code: "microsoft_unavailable",
          contractVersion: "v1",
          retryable: true,
          status: "failure",
        },
        new Date(firstAttemptAt.getTime() + 60_000),
      ),
    ).resolves.toMatchObject({
      job: { attemptCount: 2, leaseExpiresAt: null, retryable: true, state: "queued" },
      tenantConnection: { state: "validating" },
    });
    retryClaim = await claimJob(retryable.job.id, new Date(firstAttemptAt.getTime() + 360_000));
    await expect(
      applyTenantValidationResult(
        database,
        retryable.job.id,
        retryClaim.job.leaseToken,
        {
          code: "microsoft_unavailable",
          contractVersion: "v1",
          retryable: true,
          status: "failure",
        },
        new Date(firstAttemptAt.getTime() + 360_000),
      ),
    ).resolves.toMatchObject({
      job: {
        attemptCount: 3,
        failureCode: "microsoft_unavailable",
        leaseExpiresAt: null,
        retryable: true,
        state: "failed",
      },
      tenantConnection: { state: "validation_failed" },
    });
  });

  it("terminally fails nonretryable results and clears their lease", async () => {
    const started = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "terminal-failure",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    if (started.status !== "accepted") {
      throw new Error("Expected accepted validation");
    }

    const claimed = await claimJob(started.job.id);
    await expect(
      applyTenantValidationResult(database, started.job.id, claimed.job.leaseToken, {
        code: "invalid_credentials",
        contractVersion: "v1",
        retryable: false,
        status: "failure",
      }),
    ).resolves.toMatchObject({
      job: {
        failureCode: "invalid_credentials",
        leaseExpiresAt: null,
        retryable: false,
        state: "failed",
      },
      tenantConnection: { state: "validation_failed" },
    });
  });

  it("rejects stale results after an expired lease is reclaimed", async () => {
    const started = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "stale-result",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    if (started.status !== "accepted") {
      throw new Error("Expected accepted validation");
    }
    const firstClaim = await claimJob(started.job.id, new Date("2026-01-01T00:00:00.000Z"));
    const secondClaim = await claimJob(started.job.id, new Date("2026-01-01T00:01:01.000Z"));

    await expect(
      applyTenantValidationResult(database, started.job.id, firstClaim.job.leaseToken, {
        contractVersion: "v1",
        microsoftTenantId: "stale-tenant",
        status: "success",
      }),
    ).resolves.toEqual({ status: "stale" });
    await expect(
      applyTenantValidationResult(
        database,
        started.job.id,
        secondClaim.job.leaseToken,
        {
          contractVersion: "v1",
          microsoftTenantId: "current-tenant",
          status: "success",
        },
        new Date("2026-01-01T00:01:02.000Z"),
      ),
    ).resolves.toMatchObject({
      job: { state: "completed" },
      tenantConnection: { state: "active" },
    });
  });

  it("renews leases only for their current fencing token", async () => {
    const started = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "lease-renewal",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    if (started.status !== "accepted") {
      throw new Error("Expected accepted validation");
    }
    const claimed = await claimJob(started.job.id, new Date("2026-01-01T00:00:00.000Z"));

    await expect(
      renewTenantValidationJobLease(
        database,
        started.job.id,
        crypto.randomUUID(),
        new Date("2026-01-01T00:00:30.000Z"),
      ),
    ).resolves.toBe(false);
    await expect(
      renewTenantValidationJobLease(
        database,
        started.job.id,
        claimed.job.leaseToken,
        new Date("2026-01-01T00:00:30.000Z"),
      ),
    ).resolves.toBe(true);
    const [renewed] = await database.select().from(job).where(eq(job.id, started.job.id));
    expect(renewed?.leaseExpiresAt).toEqual(new Date("2026-01-01T00:01:30.000Z"));
  });

  it("does not renew an expired lease before recovery", async () => {
    const started = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "expired-lease-renewal",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    if (started.status !== "accepted") {
      throw new Error("Expected accepted validation");
    }

    const claimed = await claimJob(started.job.id, new Date("2026-01-01T00:00:00.000Z"));
    await expect(
      renewTenantValidationJobLease(
        database,
        started.job.id,
        claimed.job.leaseToken,
        new Date("2026-01-01T00:01:00.000Z"),
      ),
    ).resolves.toBe(false);

    const [storedJob] = await database.select().from(job).where(eq(job.id, started.job.id));
    expect(storedJob).toMatchObject({
      leaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
      leaseToken: claimed.job.leaseToken,
      state: "running",
    });
  });

  it("rejects expired results before recovery leaves the job nonterminal", async () => {
    const started = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "expired-result",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    if (started.status !== "accepted") {
      throw new Error("Expected accepted validation");
    }

    const claimed = await claimJob(started.job.id, new Date("2026-01-01T00:00:00.000Z"));
    await expect(
      applyTenantValidationResult(
        database,
        started.job.id,
        claimed.job.leaseToken,
        {
          contractVersion: "v1",
          microsoftTenantId: "expired-result-tenant",
          status: "success",
        },
        new Date("2026-01-01T00:01:00.000Z"),
      ),
    ).resolves.toEqual({ status: "stale" });

    const [storedJob] = await database.select().from(job).where(eq(job.id, started.job.id));
    const [storedTenant] = await database
      .select()
      .from(tenantConnection)
      .where(eq(tenantConnection.id, started.tenantConnection.id));
    expect(storedJob).toMatchObject({
      leaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
      leaseToken: claimed.job.leaseToken,
      state: "running",
    });
    expect(storedTenant).toMatchObject({ microsoftTenantId: null, state: "validating" });
  });

  it("persists delayed retries and immediate expired-lease recovery events", async () => {
    const retryable = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "retry-outbox",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    const expiring = await startTenantValidation(
      database,
      organizationWriteGrant(),
      {
        credentials,
        idempotencyKey: "recovery-outbox",
        workspaceId: workspaceOneOtherId,
      },
      cipher,
    );
    if (retryable.status !== "accepted" || expiring.status !== "accepted") {
      throw new Error("Expected accepted validations");
    }
    const retryAt = new Date("2026-01-01T00:00:00.000Z");
    const retryClaim = await claimJob(retryable.job.id, retryAt);
    await applyTenantValidationResult(
      database,
      retryable.job.id,
      retryClaim.job.leaseToken,
      {
        code: "microsoft_unavailable",
        contractVersion: "v1",
        retryable: true,
        status: "failure",
      },
      retryAt,
    );
    const retryEvents = await database
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.jobId, retryable.job.id));
    const [retriedJob] = await database.select().from(job).where(eq(job.id, retryable.job.id));
    expect(retryEvents).toHaveLength(2);
    expect(retriedJob?.availableAt).toEqual(new Date(retryAt.getTime() + 60_000));
    expect(
      retryEvents.find((event) => event.availableAt.getTime() === retryAt.getTime() + 60_000),
    ).toMatchObject({
      payload: { jobId: retryable.job.id },
    });

    await claimJob(expiring.job.id, retryAt);
    await expect(
      recoverExpiredTenantValidationJobs(database, new Date("2026-01-01T00:01:00.000Z")),
    ).resolves.toBe(1);
    const recovered = await database.select().from(job).where(eq(job.id, expiring.job.id));
    const recoveryEvents = await database
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.jobId, expiring.job.id));
    expect(recovered[0]).toMatchObject({
      availableAt: new Date("2026-01-01T00:01:00.000Z"),
      leaseExpiresAt: null,
      leaseToken: null,
      state: "queued",
    });
    expect(recoveryEvents).toHaveLength(2);
    expect(
      recoveryEvents.find((event) => event.availableAt.getTime() === retryAt.getTime() + 60_000),
    ).toMatchObject({
      payload: { jobId: expiring.job.id },
    });
  });

  it("enforces one non-terminal job per tenant connection", async () => {
    const started = await startTenantValidation(
      database,
      workspaceWriteGrant(),
      {
        credentials,
        idempotencyKey: "non-terminal-constraint",
        workspaceId: workspaceOneId,
      },
      cipher,
    );
    if (started.status !== "accepted") {
      throw new Error("Expected accepted validation");
    }

    await expect(
      database.insert(job).values({
        operation: "tenant_validation",
        state: "running",
        tenantConnectionId: started.tenantConnection.id,
      }),
    ).rejects.toThrow();
  });

  it("rolls back every record when a targeted idempotency constraint rejects the command", async () => {
    await database.execute(
      sql`ALTER TABLE idempotency_record ADD CONSTRAINT tenant_validation_test_idempotency_key_check CHECK (key <> 'rollback') NOT VALID`,
    );
    try {
      await expect(
        startTenantValidation(
          database,
          workspaceWriteGrant(),
          {
            credentials,
            idempotencyKey: "rollback",
            workspaceId: workspaceOneId,
          },
          cipher,
        ),
      ).rejects.toThrow();
    } finally {
      await database.execute(
        sql`ALTER TABLE idempotency_record DROP CONSTRAINT tenant_validation_test_idempotency_key_check`,
      );
    }

    const tenants = await database
      .select()
      .from(tenantConnection)
      .where(eq(tenantConnection.workspaceId, workspaceOneId));
    const records = await database
      .select()
      .from(idempotencyRecord)
      .where(
        and(
          eq(idempotencyRecord.organizationId, organizationOneId),
          eq(idempotencyRecord.key, "rollback"),
        ),
      );
    const jobs = await database
      .select()
      .from(job)
      .where(
        inArray(
          job.tenantConnectionId,
          tenants.map((tenant) => tenant.id),
        ),
      );
    const events =
      jobs.length === 0
        ? []
        : await database
            .select()
            .from(outboxEvent)
            .where(
              inArray(
                outboxEvent.jobId,
                jobs.map((storedJob) => storedJob.id),
              ),
            );

    expect(tenants).toHaveLength(0);
    expect(records).toHaveLength(0);
    expect(jobs).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});
