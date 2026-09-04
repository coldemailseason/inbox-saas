import type { Database } from "@inbox-saas/db";
import {
  idempotencyRecord,
  job,
  outboxEvent,
  tenantConnection,
  workspace,
} from "@inbox-saas/db/schema";
import type { TenantValidationResult } from "@inbox-saas/provisioner-contract";
import { and, eq, gt, lte, or, sql } from "drizzle-orm";

import { type AccessGrant, isAuthorized } from "./access.js";
import { getOrganizationEntitlement } from "./entitlements.js";
import { type TenantCredentialCipher, type TenantCredentials } from "./tenant-credentials.js";

const tenantValidationOperation = "tenant_validation" as const;

export type TenantConnectionDto = Omit<
  typeof tenantConnection.$inferSelect,
  "credentialCiphertext" | "credentialIv" | "credentialAuthTag" | "credentialKeyVersion"
>;

export type TenantValidationJobDto = typeof job.$inferSelect;

export type StartTenantValidationInput = {
  workspaceId: string;
  idempotencyKey: string;
  credentials: TenantCredentials;
};

export type StartTenantValidationResult =
  | { status: "not_found" }
  | { status: "idempotency_conflict" }
  | {
      status: "accepted";
      tenantConnection: TenantConnectionDto;
      job: TenantValidationJobDto;
      reused: boolean;
    };

export type GetTenantValidationJobResult =
  | { status: "not_found" }
  | { status: "found"; tenantConnection: TenantConnectionDto; job: TenantValidationJobDto };

export type ApplyTenantValidationResult =
  | { status: "not_found" }
  | { status: "stale" }
  | {
      status: "applied";
      tenantConnection: TenantConnectionDto;
      job: TenantValidationJobDto;
      reused: boolean;
    };

export type ClaimTenantValidationJobResult =
  | { status: "not_found" }
  | { status: "claimed"; tenantConnection: TenantConnectionDto; job: TenantValidationJobDto };

const retryDelaysMs = [60_000, 300_000] as const;

function retryAvailableAt(attemptCount: number, now: Date): Date {
  const delayMs = retryDelaysMs[attemptCount - 1];
  if (delayMs === undefined) {
    throw new Error("Tenant validation job has no remaining retry delay");
  }
  return new Date(now.getTime() + delayMs);
}

function toTenantConnectionDto(
  connection: typeof tenantConnection.$inferSelect,
): TenantConnectionDto {
  const {
    credentialAuthTag: _credentialAuthTag,
    credentialCiphertext: _credentialCiphertext,
    credentialIv: _credentialIv,
    credentialKeyVersion: _credentialKeyVersion,
    ...safeConnection
  } = connection;
  return safeConnection;
}

function assertStartInput(input: StartTenantValidationInput): void {
  if (!input.idempotencyKey) {
    throw new Error("Idempotency key is required");
  }

  if (!input.credentials.email || !input.credentials.password) {
    throw new Error("Tenant administrator email and password are required");
  }
}

async function getJobWithTenant(database: Database, jobId: string) {
  const [storedJob] = await database.select().from(job).where(eq(job.id, jobId));
  if (!storedJob) {
    return null;
  }

  const [connection] = await database
    .select()
    .from(tenantConnection)
    .where(eq(tenantConnection.id, storedJob.tenantConnectionId));
  if (!connection) {
    throw new Error("Tenant validation job has no tenant connection");
  }

  return { connection, storedJob };
}

function isUniqueViolation(error: unknown): boolean {
  let current = error;
  while (typeof current === "object" && current !== null) {
    if ("code" in current && (current as { code?: unknown }).code === "23505") {
      return true;
    }
    if (!("cause" in current)) {
      return false;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function startTenantValidation(
  database: Database,
  grants: readonly AccessGrant[],
  input: StartTenantValidationInput,
  cipher: TenantCredentialCipher,
): Promise<StartTenantValidationResult> {
  assertStartInput(input);

  const [targetWorkspace] = await database
    .select()
    .from(workspace)
    .where(eq(workspace.id, input.workspaceId));
  if (
    !targetWorkspace ||
    !isAuthorized(grants, {
      organizationId: targetWorkspace.organizationId,
      permission: "write",
      scope: "workspace",
      workspaceId: targetWorkspace.id,
    })
  ) {
    return { status: "not_found" };
  }

  const entitlement = getOrganizationEntitlement(targetWorkspace.organizationId);
  if (!entitlement.entitled) {
    throw new Error("Organization is not entitled to validate tenants");
  }

  const encryptedCredentials = cipher.encrypt(input.credentials, {
    operation: tenantValidationOperation,
    workspaceId: targetWorkspace.id,
  });
  const payloadFingerprint = cipher.fingerprint({
    ...input.credentials,
    operation: tenantValidationOperation,
    workspaceId: input.workspaceId,
  });

  try {
    return await database.transaction(async (transaction) => {
      const [existingRecord] = await transaction
        .select()
        .from(idempotencyRecord)
        .where(
          and(
            eq(idempotencyRecord.organizationId, targetWorkspace.organizationId),
            eq(idempotencyRecord.key, input.idempotencyKey),
          ),
        );

      if (existingRecord) {
        if (
          existingRecord.operation !== tenantValidationOperation ||
          existingRecord.payloadFingerprint !== payloadFingerprint
        ) {
          return { status: "idempotency_conflict" };
        }

        const [existingJob] = await transaction
          .select()
          .from(job)
          .where(eq(job.id, existingRecord.jobId));
        if (!existingJob) {
          throw new Error("Idempotency record has no job");
        }
        const [existingTenantConnection] = await transaction
          .select()
          .from(tenantConnection)
          .where(eq(tenantConnection.id, existingJob.tenantConnectionId));
        if (!existingTenantConnection) {
          throw new Error("Tenant validation job has no tenant connection");
        }

        return {
          status: "accepted",
          tenantConnection: toTenantConnectionDto(existingTenantConnection),
          job: existingJob,
          reused: true,
        };
      }

      const [newTenantConnection] = await transaction
        .insert(tenantConnection)
        .values({
          credentialAuthTag: encryptedCredentials.authTag,
          credentialCiphertext: encryptedCredentials.ciphertext,
          credentialIv: encryptedCredentials.iv,
          credentialKeyVersion: encryptedCredentials.keyVersion,
          organizationId: targetWorkspace.organizationId,
          state: "validating",
          workspaceId: targetWorkspace.id,
        })
        .returning();
      if (!newTenantConnection) {
        throw new Error("Failed to create tenant connection");
      }

      const [newJob] = await transaction
        .insert(job)
        .values({
          operation: tenantValidationOperation,
          state: "queued",
          tenantConnectionId: newTenantConnection.id,
        })
        .returning();
      if (!newJob) {
        throw new Error("Failed to create tenant validation job");
      }

      await transaction.insert(idempotencyRecord).values({
        jobId: newJob.id,
        key: input.idempotencyKey,
        operation: tenantValidationOperation,
        organizationId: targetWorkspace.organizationId,
        payloadFingerprint,
      });
      await transaction.insert(outboxEvent).values({
        jobId: newJob.id,
        payload: { jobId: newJob.id },
        type: "tenant_validation_requested",
      });

      return {
        status: "accepted",
        tenantConnection: toTenantConnectionDto(newTenantConnection),
        job: newJob,
        reused: false,
      };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    const [existingRecord] = await database
      .select()
      .from(idempotencyRecord)
      .where(
        and(
          eq(idempotencyRecord.organizationId, targetWorkspace.organizationId),
          eq(idempotencyRecord.key, input.idempotencyKey),
        ),
      );
    if (
      !existingRecord ||
      existingRecord.operation !== tenantValidationOperation ||
      existingRecord.payloadFingerprint !== payloadFingerprint
    ) {
      return { status: "idempotency_conflict" };
    }

    const existing = await getJobWithTenant(database, existingRecord.jobId);
    if (!existing) {
      throw new Error("Idempotency record has no job");
    }

    return {
      status: "accepted",
      tenantConnection: toTenantConnectionDto(existing.connection),
      job: existing.storedJob,
      reused: true,
    };
  }
}

export async function getTenantValidationJob(
  database: Database,
  grants: readonly AccessGrant[],
  jobId: string,
): Promise<GetTenantValidationJobResult> {
  const stored = await getJobWithTenant(database, jobId);
  if (
    !stored ||
    !isAuthorized(grants, {
      organizationId: stored.connection.organizationId,
      permission: "read",
      scope: "workspace",
      workspaceId: stored.connection.workspaceId,
    })
  ) {
    return { status: "not_found" };
  }

  return {
    status: "found",
    tenantConnection: toTenantConnectionDto(stored.connection),
    job: stored.storedJob,
  };
}

export async function claimTenantValidationJob(
  database: Database,
  jobId: string,
  now = new Date(),
  leaseDurationMs = 60_000,
): Promise<ClaimTenantValidationJobResult> {
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("Lease duration must be a positive finite number");
  }

  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
  const leaseToken = crypto.randomUUID();
  const [claimedJob] = await database
    .update(job)
    .set({
      attemptCount: sql`${job.attemptCount} + 1`,
      availableAt: now,
      leaseExpiresAt,
      leaseToken,
      state: "running",
    })
    .where(
      and(
        eq(job.id, jobId),
        or(
          and(eq(job.state, "queued"), lte(job.availableAt, now)),
          and(eq(job.state, "running"), lte(job.leaseExpiresAt, now)),
        ),
      ),
    )
    .returning();
  if (!claimedJob) {
    return { status: "not_found" };
  }

  const [connection] = await database
    .select()
    .from(tenantConnection)
    .where(eq(tenantConnection.id, claimedJob.tenantConnectionId));
  if (!connection) {
    throw new Error("Tenant validation job has no tenant connection");
  }

  return {
    status: "claimed",
    tenantConnection: toTenantConnectionDto(connection),
    job: claimedJob,
  };
}

export async function renewTenantValidationJobLease(
  database: Database,
  jobId: string,
  leaseToken: string,
  now = new Date(),
  leaseDurationMs = 60_000,
): Promise<boolean> {
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("Lease duration must be a positive finite number");
  }

  const [renewed] = await database
    .update(job)
    .set({ leaseExpiresAt: new Date(now.getTime() + leaseDurationMs) })
    .where(
      and(
        eq(job.id, jobId),
        eq(job.state, "running"),
        eq(job.leaseToken, leaseToken),
        gt(job.leaseExpiresAt, now),
      ),
    )
    .returning({ id: job.id });
  return Boolean(renewed);
}

export async function recoverExpiredTenantValidationJobs(
  database: Database,
  now = new Date(),
): Promise<number> {
  return database.transaction(async (transaction) => {
    const expiredJobs = await transaction
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          eq(job.operation, tenantValidationOperation),
          eq(job.state, "running"),
          lte(job.leaseExpiresAt, now),
        ),
      );

    let recoveredCount = 0;
    for (const expiredJob of expiredJobs) {
      const [recoveredJob] = await transaction
        .update(job)
        .set({ availableAt: now, leaseExpiresAt: null, leaseToken: null, state: "queued" })
        .where(
          and(eq(job.id, expiredJob.id), eq(job.state, "running"), lte(job.leaseExpiresAt, now)),
        )
        .returning({ id: job.id });
      if (!recoveredJob) {
        continue;
      }
      await transaction.insert(outboxEvent).values({
        availableAt: now,
        jobId: recoveredJob.id,
        payload: { jobId: recoveredJob.id },
        type: "tenant_validation_requested",
      });
      recoveredCount += 1;
    }
    return recoveredCount;
  });
}

export async function applyTenantValidationResult(
  database: Database,
  jobId: string,
  leaseToken: string,
  result: TenantValidationResult,
  now = new Date(),
): Promise<ApplyTenantValidationResult> {
  try {
    return await database.transaction(async (transaction) => {
      const [currentJob] = await transaction.select().from(job).where(eq(job.id, jobId));
      if (!currentJob) {
        return { status: "not_found" } as const;
      }

      if (
        currentJob.state !== "running" ||
        currentJob.leaseToken !== leaseToken ||
        !currentJob.leaseExpiresAt ||
        currentJob.leaseExpiresAt <= now
      ) {
        return { status: "stale" } as const;
      }

      const [currentConnection] = await transaction
        .select()
        .from(tenantConnection)
        .where(eq(tenantConnection.id, currentJob.tenantConnectionId));
      if (!currentConnection) {
        throw new Error("Tenant validation job has no tenant connection");
      }
      const shouldRetry =
        result.status === "failure" && result.retryable && currentJob.attemptCount < 3;
      const tenantUpdate =
        result.status === "success"
          ? { microsoftTenantId: result.microsoftTenantId, state: "active" as const }
          : { state: shouldRetry ? ("validating" as const) : ("validation_failed" as const) };
      const availableAt = shouldRetry ? retryAvailableAt(currentJob.attemptCount, now) : now;
      const jobUpdate =
        result.status === "success"
          ? {
              availableAt,
              failureCode: null,
              leaseExpiresAt: null,
              leaseToken: null,
              retryable: null,
              state: "completed" as const,
            }
          : shouldRetry
            ? {
                availableAt,
                failureCode: result.code,
                leaseExpiresAt: null,
                leaseToken: null,
                retryable: true,
                state: "queued" as const,
              }
            : {
                availableAt,
                failureCode: result.code,
                leaseExpiresAt: null,
                leaseToken: null,
                retryable: result.retryable,
                state: "failed" as const,
              };

      const [updatedJob] = await transaction
        .update(job)
        .set(jobUpdate)
        .where(
          and(
            eq(job.id, currentJob.id),
            eq(job.state, "running"),
            eq(job.leaseToken, leaseToken),
            gt(job.leaseExpiresAt, now),
          ),
        )
        .returning();
      if (!updatedJob) {
        return { status: "stale" } as const;
      }
      const [updatedConnection] = await transaction
        .update(tenantConnection)
        .set(tenantUpdate)
        .where(eq(tenantConnection.id, currentConnection.id))
        .returning();
      if (!updatedConnection) {
        throw new Error("Failed to apply tenant validation result");
      }

      if (shouldRetry) {
        await transaction.insert(outboxEvent).values({
          availableAt,
          jobId: updatedJob.id,
          payload: { jobId: updatedJob.id },
          type: "tenant_validation_requested",
        });
      }

      return {
        status: "applied",
        tenantConnection: toTenantConnectionDto(updatedConnection),
        job: updatedJob,
        reused: false,
      } as const;
    });
  } catch (error) {
    if (!isUniqueViolation(error) || result.status !== "success") {
      throw error;
    }

    return database.transaction(async (transaction) => {
      const [currentJob] = await transaction.select().from(job).where(eq(job.id, jobId));
      if (!currentJob) {
        return { status: "not_found" } as const;
      }
      if (
        currentJob.state !== "running" ||
        currentJob.leaseToken !== leaseToken ||
        !currentJob.leaseExpiresAt ||
        currentJob.leaseExpiresAt <= now
      ) {
        return { status: "stale" } as const;
      }
      const [currentConnection] = await transaction
        .select()
        .from(tenantConnection)
        .where(eq(tenantConnection.id, currentJob.tenantConnectionId));
      if (!currentConnection) {
        throw new Error("Tenant validation job has no tenant connection");
      }
      const [updatedJob] = await transaction
        .update(job)
        .set({
          availableAt: now,
          failureCode: "tenant_already_connected",
          leaseExpiresAt: null,
          leaseToken: null,
          retryable: false,
          state: "failed",
        })
        .where(
          and(
            eq(job.id, currentJob.id),
            eq(job.state, "running"),
            eq(job.leaseToken, leaseToken),
            gt(job.leaseExpiresAt, now),
          ),
        )
        .returning();
      if (!updatedJob) {
        return { status: "stale" } as const;
      }
      const [updatedConnection] = await transaction
        .update(tenantConnection)
        .set({ state: "validation_failed" })
        .where(eq(tenantConnection.id, currentJob.tenantConnectionId))
        .returning();
      if (!updatedConnection) {
        throw new Error("Failed to apply tenant validation collision result");
      }

      return {
        status: "applied",
        tenantConnection: toTenantConnectionDto(updatedConnection),
        job: updatedJob,
        reused: false,
      } as const;
    });
  }
}
