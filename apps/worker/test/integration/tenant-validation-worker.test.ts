import {
  accessGrant,
  createDb,
  job,
  organization,
  outboxEvent,
  tenantConnection,
  user,
  workspace,
} from "@inbox-saas/db";
import { createTenantCredentialCipher, startTenantValidation } from "@inbox-saas/product";
import type {
  TenantValidationProvisioner,
  TenantValidationRequest,
  TenantValidationResult,
} from "@inbox-saas/provisioner-contract";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeTenantValidationProvisioner } from "../../src/fake-provisioner.js";
import { MicrosoftWorkLimiter } from "../../src/microsoft-work-limiter.js";
import {
  createTenantValidationWorker,
  dispatchPendingTenantValidationOutboxEvents,
  processTenantValidationJob,
  runTenantValidationWorkerTick,
  type TenantValidationQueue,
} from "../../src/tenant-validation-worker.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.includes("test")) {
  throw new Error("TEST_DATABASE_URL must point to an isolated test database");
}

const database = createDb(testDatabaseUrl);
const cipher = createTenantCredentialCipher({ key: Buffer.alloc(32, 11), keyVersion: "test-v1" });
const credentials = { email: "tenant-admin@example.test", password: "private-password" };

type Enqueue = { jobId: string; options?: { delayMs?: number } };

class FakeQueue implements TenantValidationQueue {
  readonly enqueues: Enqueue[] = [];
  fail = false;

  async enqueue(jobId: string, options?: { delayMs?: number }): Promise<void> {
    if (this.fail) {
      throw new Error("queue unavailable");
    }
    this.enqueues.push({ jobId, options });
  }

  async register(): Promise<void> {}
}

let userId: string;
let organizationId: string;
let workspaceId: string;
let additionalOrganizationIds: string[];

class DelayedProvisioner implements TenantValidationProvisioner {
  readonly requests: TenantValidationRequest[] = [];
  #pending: Array<(result: TenantValidationResult) => void> = [];

  validateTenant(request: TenantValidationRequest): Promise<TenantValidationResult> {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.#pending.push(resolve);
    });
  }

  releaseNext(result: TenantValidationResult): void {
    const resolve = this.#pending.shift();
    if (!resolve) {
      throw new Error("No pending provisioner call");
    }
    resolve(result);
  }

  get pendingCount(): number {
    return this.#pending.length;
  }
}

const successfulProvisioning: TenantValidationResult = {
  contractVersion: "v1",
  microsoftTenantId: "delayed-tenant",
  status: "success",
};

function grants() {
  return [
    {
      organizationId,
      permission: "write" as const,
      scope: "workspace" as const,
      workspaceId,
    },
  ];
}

async function startValidation(idempotencyKey: string) {
  const started = await startTenantValidation(
    database,
    grants(),
    { credentials, idempotencyKey, workspaceId },
    cipher,
  );
  if (started.status !== "accepted") {
    throw new Error("Expected accepted tenant validation");
  }
  return started;
}

async function startValidationInNewOrganization(idempotencyKey: string) {
  const [createdOrganization] = await database
    .insert(organization)
    .values({ name: `Additional Worker Organization ${crypto.randomUUID()}` })
    .returning({ id: organization.id });
  if (!createdOrganization) {
    throw new Error("Expected organization");
  }
  additionalOrganizationIds.push(createdOrganization.id);
  const [createdWorkspace] = await database
    .insert(workspace)
    .values({ name: "Additional Worker Workspace", organizationId: createdOrganization.id })
    .returning({ id: workspace.id });
  if (!createdWorkspace) {
    throw new Error("Expected workspace");
  }
  const started = await startTenantValidation(
    database,
    [
      {
        organizationId: createdOrganization.id,
        permission: "write",
        scope: "workspace",
        workspaceId: createdWorkspace.id,
      },
    ],
    { credentials, idempotencyKey, workspaceId: createdWorkspace.id },
    cipher,
  );
  if (started.status !== "accepted") {
    throw new Error("Expected accepted tenant validation");
  }
  return started;
}

async function storedJob(jobId: string) {
  const [stored] = await database.select().from(job).where(eq(job.id, jobId));
  if (!stored) {
    throw new Error("Expected tenant validation job");
  }
  return stored;
}

beforeEach(async () => {
  additionalOrganizationIds = [];
  const suffix = crypto.randomUUID();
  userId = `worker-user-${suffix}`;
  await database.insert(user).values({
    id: userId,
    name: "Worker User",
    email: `worker-${suffix}@example.test`,
    initialOrganizationName: "Initial Worker Organization",
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

  const [createdOrganization] = await database
    .insert(organization)
    .values({ name: "Worker Organization" })
    .returning({ id: organization.id });
  if (!createdOrganization) {
    throw new Error("Expected organization");
  }
  organizationId = createdOrganization.id;
  const [createdWorkspace] = await database
    .insert(workspace)
    .values({ name: "Worker Workspace", organizationId })
    .returning({ id: workspace.id });
  if (!createdWorkspace) {
    throw new Error("Expected workspace");
  }
  workspaceId = createdWorkspace.id;
});

afterEach(async () => {
  if (additionalOrganizationIds.length > 0) {
    await database.delete(organization).where(inArray(organization.id, additionalOrganizationIds));
  }
  await database.delete(organization).where(eq(organization.id, organizationId));
  await database.delete(user).where(eq(user.id, userId));
});

describe("tenant validation worker", () => {
  it("dispatches only job IDs and leaves failed sends undispatched", async () => {
    const started = await startValidation("outbox");
    const queue = new FakeQueue();
    queue.fail = true;

    await dispatchPendingTenantValidationOutboxEvents(database, queue);
    const [undispatched] = await database
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.jobId, started.job.id));
    expect(undispatched?.dispatchedAt).toBeNull();

    queue.fail = false;
    await dispatchPendingTenantValidationOutboxEvents(database, queue);
    const [dispatched] = await database
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.jobId, started.job.id));
    expect(queue.enqueues).toContainEqual({ jobId: started.job.id, options: undefined });
    expect(dispatched?.dispatchedAt).toBeInstanceOf(Date);
  });

  it("decrypts only for the fake provisioner and safely activates the tenant", async () => {
    const started = await startValidation("success");
    const provisioner = new FakeTenantValidationProvisioner(
      { contractVersion: "v1", microsoftTenantId: "tenant-success", status: "success" },
      (request) => expect(request.credentials).toEqual(credentials),
    );

    const result = await processTenantValidationJob({
      database,
      cipher,
      credentialKeyVersion: "test-v1",
      jobId: started.job.id,
      provisioner,
    });

    expect(result).toMatchObject({
      status: "applied",
      job: { state: "completed" },
      tenantConnection: { state: "active" },
    });
    expect(provisioner.invocations).toEqual([
      {
        contractVersion: "v1",
        jobId: started.job.id,
        tenantConnectionId: started.tenantConnection.id,
      },
    ]);
    expect(
      JSON.stringify({
        result,
        outbox: await database.select().from(outboxEvent),
        job: await storedJob(started.job.id),
      }),
    ).not.toContain(credentials.email);
    expect(
      JSON.stringify({
        result,
        outbox: await database.select().from(outboxEvent),
        job: await storedJob(started.job.id),
      }),
    ).not.toContain(credentials.password);
  });

  it("rejects credentials transplanted to another workspace before provisioning", async () => {
    const started = await startValidation("credential-workspace-transplant");
    const [otherWorkspace] = await database
      .insert(workspace)
      .values({ name: "Other Worker Workspace", organizationId })
      .returning({ id: workspace.id });
    if (!otherWorkspace) {
      throw new Error("Expected other workspace");
    }
    await database
      .update(tenantConnection)
      .set({ workspaceId: otherWorkspace.id })
      .where(eq(tenantConnection.id, started.tenantConnection.id));
    const provisioner = new FakeTenantValidationProvisioner({
      contractVersion: "v1",
      microsoftTenantId: "not-called",
      status: "success",
    });

    await expect(
      processTenantValidationJob({
        database,
        cipher,
        credentialKeyVersion: "test-v1",
        jobId: started.job.id,
        provisioner,
      }),
    ).rejects.toThrow("Tenant validation job processing failed");
    expect(provisioner.invocations).toEqual([]);
  });

  it("durably requeues retryable failures through delayed Product-owned outbox events", async () => {
    const started = await startValidation("retry");
    const queue = new FakeQueue();
    const provisioner = new FakeTenantValidationProvisioner({
      code: "microsoft_unavailable",
      contractVersion: "v1",
      retryable: true,
      status: "failure",
    });

    const firstAttemptAt = new Date();
    for (const now of [
      firstAttemptAt,
      new Date(firstAttemptAt.getTime() + 60_000),
      new Date(firstAttemptAt.getTime() + 360_000),
    ]) {
      await processTenantValidationJob({
        database,
        cipher,
        credentialKeyVersion: "test-v1",
        jobId: started.job.id,
        now,
        provisioner,
      });
    }

    expect(queue.enqueues).toEqual([]);
    expect(await storedJob(started.job.id)).toMatchObject({
      attemptCount: 3,
      state: "failed",
      retryable: true,
    });
  });

  it("retries provisioner transport failures through Product's delayed retry policy", async () => {
    const started = await startValidation("transport-retry");
    const attemptedAt = new Date();
    const provisioner: TenantValidationProvisioner = {
      validateTenant: async () => {
        throw new Error("network unavailable");
      },
    };

    await processTenantValidationJob({
      database,
      cipher,
      credentialKeyVersion: "test-v1",
      jobId: started.job.id,
      now: attemptedAt,
      provisioner,
    });

    expect(await storedJob(started.job.id)).toMatchObject({
      attemptCount: 1,
      availableAt: new Date(attemptedAt.getTime() + 60_000),
      failureCode: "unexpected_failure",
      retryable: true,
      state: "queued",
    });
  });

  it("terminally fails repeated provisioner transport failures through Product attempts", async () => {
    const started = await startValidation("transport-terminal-failure");
    const provisioner: TenantValidationProvisioner = {
      validateTenant: async () => {
        throw new Error("network unavailable");
      },
    };
    const firstAttemptAt = new Date();

    for (const now of [
      firstAttemptAt,
      new Date(firstAttemptAt.getTime() + 60_000),
      new Date(firstAttemptAt.getTime() + 360_000),
    ]) {
      await processTenantValidationJob({
        database,
        cipher,
        credentialKeyVersion: "test-v1",
        jobId: started.job.id,
        now,
        provisioner,
      });
    }

    expect(await storedJob(started.job.id)).toMatchObject({
      attemptCount: 3,
      failureCode: "unexpected_failure",
      retryable: true,
      state: "failed",
    });
  });

  it("does not requeue nonretryable failures or Microsoft tenant collisions", async () => {
    const nonretryable = await startValidation("nonretryable");
    const queue = new FakeQueue();
    await processTenantValidationJob({
      database,
      cipher,
      credentialKeyVersion: "test-v1",
      jobId: nonretryable.job.id,
      provisioner: new FakeTenantValidationProvisioner({
        code: "invalid_credentials",
        contractVersion: "v1",
        retryable: false,
        status: "failure",
      }),
    });

    const first = await startValidation("collision-first");
    const second = await startValidation("collision-second");
    const success = {
      contractVersion: "v1" as const,
      microsoftTenantId: "tenant-collision",
      status: "success" as const,
    };
    await processTenantValidationJob({
      database,
      cipher,
      credentialKeyVersion: "test-v1",
      jobId: first.job.id,
      provisioner: new FakeTenantValidationProvisioner(success),
    });
    await processTenantValidationJob({
      database,
      cipher,
      credentialKeyVersion: "test-v1",
      jobId: second.job.id,
      provisioner: new FakeTenantValidationProvisioner(success),
    });

    expect(queue.enqueues).toEqual([]);
    expect(await storedJob(nonretryable.job.id)).toMatchObject({
      state: "failed",
      retryable: false,
    });
    expect(await storedJob(second.job.id)).toMatchObject({
      failureCode: "tenant_already_connected",
      state: "failed",
    });
  });

  it("does nothing when a job is already leased", async () => {
    const started = await startValidation("leased");
    await database
      .update(job)
      .set({ leaseExpiresAt: new Date(Date.now() + 60_000), state: "running" })
      .where(eq(job.id, started.job.id));
    const provisioner = new FakeTenantValidationProvisioner({
      contractVersion: "v1",
      microsoftTenantId: "not-called",
      status: "success",
    });

    await expect(
      processTenantValidationJob({
        database,
        cipher,
        credentialKeyVersion: "test-v1",
        jobId: started.job.id,
        provisioner,
      }),
    ).resolves.toEqual({ status: "not_claimed" });
    expect(provisioner.invocations).toEqual([]);
  });

  it("waits to make a fourth same-organization provisioner call", async () => {
    const limiter = new MicrosoftWorkLimiter();
    const provisioner = new DelayedProvisioner();
    const started = await Promise.all(
      Array.from({ length: 4 }, (_, index) => startValidation(`same-organization-${index}`)),
    );
    const processing = started.map(({ job }) =>
      processTenantValidationJob({
        database,
        cipher,
        credentialKeyVersion: "test-v1",
        jobId: job.id,
        limiter,
        provisioner,
      }),
    );

    await vi.waitFor(() => expect(provisioner.requests).toHaveLength(3), {
      interval: 10,
      timeout: 2_000,
    });
    provisioner.releaseNext(successfulProvisioning);
    await vi.waitFor(() => expect(provisioner.requests).toHaveLength(4), {
      interval: 10,
      timeout: 2_000,
    });
    while (provisioner.pendingCount > 0) {
      provisioner.releaseNext(successfulProvisioning);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(processing);
  });

  it("waits to make a sixth global provisioner call", async () => {
    const limiter = new MicrosoftWorkLimiter();
    const provisioner = new DelayedProvisioner();
    const started = [
      await startValidation("global-0"),
      ...(await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          startValidationInNewOrganization(`global-${index + 1}`),
        ),
      )),
    ];
    const processing = started.map(({ job }) =>
      processTenantValidationJob({
        database,
        cipher,
        credentialKeyVersion: "test-v1",
        jobId: job.id,
        limiter,
        provisioner,
      }),
    );

    await vi.waitFor(() => expect(provisioner.requests).toHaveLength(5), {
      interval: 10,
      timeout: 2_000,
    });
    provisioner.releaseNext(successfulProvisioning);
    await vi.waitFor(() => expect(provisioner.requests).toHaveLength(6), {
      interval: 10,
      timeout: 2_000,
    });
    while (provisioner.pendingCount > 0) {
      provisioner.releaseNext(successfulProvisioning);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(processing);
  });

  it("renews a claimed lease while waiting for Microsoft capacity", async () => {
    const limiter = new MicrosoftWorkLimiter();
    const heldPermits = await Promise.all(
      Array.from({ length: 3 }, () => limiter.acquire(organizationId)),
    );
    const started = await startValidation("lease-renewal-during-capacity-wait");
    const provisioner = new DelayedProvisioner();
    const processing = processTenantValidationJob({
      database,
      cipher,
      credentialKeyVersion: "test-v1",
      jobId: started.job.id,
      limiter,
      provisioner,
    });
    await vi.waitFor(
      async () => {
        expect((await storedJob(started.job.id)).leaseExpiresAt).toBeInstanceOf(Date);
      },
      {
        interval: 10,
        timeout: 2_000,
      },
    );
    const initialLease = (await storedJob(started.job.id)).leaseExpiresAt;
    if (!initialLease) {
      throw new Error("Expected claimed job lease");
    }

    await vi.waitFor(
      async () => {
        const renewed = await storedJob(started.job.id);
        expect(renewed.leaseExpiresAt?.getTime()).toBeGreaterThan(initialLease.getTime());
      },
      {
        interval: 10,
        timeout: 25_000,
      },
    );
    heldPermits[0]?.();
    await vi.waitFor(() => expect(provisioner.requests).toHaveLength(1), {
      interval: 10,
      timeout: 2_000,
    });
    provisioner.releaseNext(successfulProvisioning);
    await processing;
    heldPermits.slice(1).forEach((release) => release());
  }, 30_000);

  it("does not invoke the provisioner after losing its lease while waiting for capacity", async () => {
    const limiter = new MicrosoftWorkLimiter();
    const heldPermits = await Promise.all(
      Array.from({ length: 3 }, () => limiter.acquire(organizationId)),
    );
    const started = await startValidation("lost-lease-during-capacity-wait");
    const provisioner = new DelayedProvisioner();
    const processing = processTenantValidationJob({
      database,
      cipher,
      credentialKeyVersion: "test-v1",
      jobId: started.job.id,
      limiter,
      provisioner,
    });

    await vi.waitFor(
      async () => {
        expect((await storedJob(started.job.id)).leaseToken).toBeTruthy();
      },
      {
        interval: 10,
        timeout: 2_000,
      },
    );
    await database
      .update(job)
      .set({ leaseToken: crypto.randomUUID() })
      .where(eq(job.id, started.job.id));

    await new Promise((resolve) => setTimeout(resolve, 21_000));
    heldPermits[0]?.();
    await expect(processing).resolves.toEqual({ status: "lease_lost" });
    expect(provisioner.requests).toEqual([]);
    heldPermits.slice(1).forEach((release) => release());
  }, 30_000);

  it("releases a permit after a retryable failure before its delayed retry", async () => {
    const limiter = new MicrosoftWorkLimiter();
    const provisioner = new DelayedProvisioner();
    const started = await Promise.all(
      Array.from({ length: 4 }, (_, index) => startValidation(`retry-release-${index}`)),
    );
    const processing = started.map(({ job }) =>
      processTenantValidationJob({
        database,
        cipher,
        credentialKeyVersion: "test-v1",
        jobId: job.id,
        limiter,
        provisioner,
      }),
    );

    await vi.waitFor(() => expect(provisioner.requests).toHaveLength(3), {
      interval: 10,
      timeout: 2_000,
    });
    const retryJobId = provisioner.requests[0]?.jobId;
    if (!retryJobId) {
      throw new Error("Expected provisioner request");
    }
    provisioner.releaseNext({
      code: "microsoft_unavailable",
      contractVersion: "v1",
      retryable: true,
      status: "failure",
    });
    await vi.waitFor(() => expect(provisioner.requests).toHaveLength(4), {
      interval: 10,
      timeout: 2_000,
    });
    expect(await storedJob(retryJobId)).toMatchObject({ retryable: true, state: "queued" });
    while (provisioner.pendingCount > 0) {
      provisioner.releaseNext(successfulProvisioning);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(processing);
  });

  it("processes a created job through the real pg-boss worker lifecycle", async () => {
    const provisioner = new FakeTenantValidationProvisioner({
      contractVersion: "v1",
      microsoftTenantId: "tenant-lifecycle",
      status: "success",
    });
    const worker = await createTenantValidationWorker({
      database,
      databaseUrl: testDatabaseUrl,
      cipher,
      credentialKeyVersion: "test-v1",
      provisioner,
    });

    try {
      const started = await startValidation("pg-boss-lifecycle");
      await worker.dispatchPendingOutbox();

      await vi.waitFor(
        async () => {
          expect(await storedJob(started.job.id)).toMatchObject({ state: "completed" });
        },
        {
          interval: 10,
          timeout: 10_000,
        },
      );

      const [completedConnection] = await database
        .select()
        .from(tenantConnection)
        .where(eq(tenantConnection.id, started.tenantConnection.id));
      expect(completedConnection).toMatchObject({
        microsoftTenantId: "tenant-lifecycle",
        state: "active",
      });
      expect(provisioner.invocations).toEqual([
        {
          contractVersion: "v1",
          jobId: started.job.id,
          tenantConnectionId: started.tenantConnection.id,
        },
      ]);
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it("does not dispatch future events until a later worker tick", async () => {
    const started = await startValidation("future-outbox");
    const queue = new FakeQueue();
    const future = new Date("2026-01-01T00:01:00.000Z");
    await database
      .update(outboxEvent)
      .set({ availableAt: future })
      .where(eq(outboxEvent.jobId, started.job.id));

    await runTenantValidationWorkerTick(database, queue, new Date("2026-01-01T00:00:00.000Z"));
    expect(queue.enqueues).toEqual([]);
    await runTenantValidationWorkerTick(database, queue, future);
    expect(queue.enqueues).toEqual([{ jobId: started.job.id, options: undefined }]);
  });

  it("dispatches commands created after an earlier worker tick", async () => {
    const queue = new FakeQueue();
    const now = new Date("2026-01-01T00:00:00.000Z");
    await runTenantValidationWorkerTick(database, queue, now);
    const started = await startValidation("post-startup-outbox");
    await database
      .update(outboxEvent)
      .set({ availableAt: now })
      .where(eq(outboxEvent.jobId, started.job.id));

    await runTenantValidationWorkerTick(database, queue, now);
    expect(queue.enqueues).toContainEqual({ jobId: started.job.id, options: undefined });
  });

  it("recovers retry and expired-lease outbox sends on a later tick", async () => {
    const retry = await startValidation("retry-send-failure");
    const expired = await startValidation("recovery-send-failure");
    const queue = new FakeQueue();
    queue.fail = true;
    await database
      .update(outboxEvent)
      .set({ availableAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(outboxEvent.jobId, retry.job.id));
    await database
      .update(job)
      .set({
        leaseExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
        leaseToken: crypto.randomUUID(),
        state: "running",
      })
      .where(eq(job.id, expired.job.id));

    await runTenantValidationWorkerTick(database, queue, new Date("2026-01-01T00:01:00.000Z"));
    const pendingEvents = await database
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.jobId, expired.job.id));
    expect(pendingEvents.some((event) => event.dispatchedAt === null)).toBe(true);

    queue.fail = false;
    await runTenantValidationWorkerTick(database, queue, new Date("2026-01-01T00:01:01.000Z"));
    expect(queue.enqueues.map((entry) => entry.jobId)).toContain(retry.job.id);
    expect(queue.enqueues.map((entry) => entry.jobId)).toContain(expired.job.id);
  });
});
