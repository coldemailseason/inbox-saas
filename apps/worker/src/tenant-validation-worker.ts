import type { Database } from "@inbox-saas/db";
import { outboxEvent, tenantConnection } from "@inbox-saas/db/schema";
import {
  applyTenantValidationResult,
  claimTenantValidationJob,
  recoverExpiredTenantValidationJobs,
  renewTenantValidationJobLease,
} from "@inbox-saas/product/tenant-validation";
import type { TenantCredentialCipher } from "@inbox-saas/product/tenant-credentials";
import {
  provisionerContractVersion,
  tenantValidationResultSchema,
  type TenantValidationProvisioner,
  type TenantValidationResult,
} from "@inbox-saas/provisioner-contract";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { log } from "evlog";
import { PgBoss } from "pg-boss";

import { MicrosoftWorkLimiter, type ReleaseMicrosoftWorkPermit } from "./microsoft-work-limiter.js";

export const tenantValidationQueueName = "tenant-validation";

export type TenantValidationQueue = {
  enqueue(jobId: string, options?: { delayMs?: number }): Promise<void>;
  register(handler: (jobId: string) => Promise<void>): Promise<void>;
};

export type ProcessTenantValidationJobInput = {
  database: Database;
  cipher: TenantCredentialCipher;
  credentialKeyVersion: string;
  provisioner: TenantValidationProvisioner;
  jobId: string;
  now?: Date;
  limiter?: Pick<MicrosoftWorkLimiter, "acquire">;
};

const leaseDurationMs = 60_000;
const leaseRenewalIntervalMs = 20_000;
export const tenantValidationWorkerTickIntervalMs = 5_000;

export async function dispatchPendingTenantValidationOutboxEvents(
  database: Database,
  queue: Pick<TenantValidationQueue, "enqueue">,
  now = new Date(),
): Promise<void> {
  const events = await database
    .select({ id: outboxEvent.id, jobId: outboxEvent.jobId, payload: outboxEvent.payload })
    .from(outboxEvent)
    .where(
      and(
        eq(outboxEvent.type, "tenant_validation_requested"),
        isNull(outboxEvent.dispatchedAt),
        lte(outboxEvent.availableAt, now),
      ),
    )
    .orderBy(asc(outboxEvent.createdAt));

  for (const event of events) {
    try {
      await queue.enqueue(event.payload.jobId);
      await database
        .update(outboxEvent)
        .set({ dispatchedAt: new Date() })
        .where(eq(outboxEvent.id, event.id));
    } catch {
      log.error({ action: "tenant_validation_outbox_dispatch_failed", jobId: event.jobId });
    }
  }
}

export async function runTenantValidationWorkerTick(
  database: Database,
  queue: Pick<TenantValidationQueue, "enqueue">,
  now = new Date(),
): Promise<void> {
  await recoverExpiredTenantValidationJobs(database, now);
  await dispatchPendingTenantValidationOutboxEvents(database, queue, now);
}

export async function processTenantValidationJob({
  database,
  cipher,
  credentialKeyVersion,
  provisioner,
  jobId,
  now,
  limiter = new MicrosoftWorkLimiter(),
}: ProcessTenantValidationJobInput) {
  let claimed;
  try {
    claimed = await claimTenantValidationJob(database, jobId, now, leaseDurationMs);
  } catch {
    log.error({ action: "tenant_validation_job_claim_failed", jobId });
    throw new Error("Tenant validation job claim failed");
  }

  if (claimed.status !== "claimed") {
    return { status: "not_claimed" as const };
  }

  const tenantConnectionId = claimed.tenantConnection.id;
  const leaseToken = claimed.job.leaseToken;
  if (!leaseToken) {
    throw new Error("Claimed tenant validation job has no lease token");
  }
  let leaseLost = false;
  const renewLease = async (renewedAt = new Date()): Promise<boolean> => {
    try {
      const renewed = await renewTenantValidationJobLease(
        database,
        jobId,
        leaseToken,
        renewedAt,
        leaseDurationMs,
      );
      if (!renewed) {
        leaseLost = true;
      }
      return renewed;
    } catch {
      leaseLost = true;
      log.error({
        action: "tenant_validation_job_lease_renewal_failed",
        jobId,
        tenantConnectionId,
      });
      return false;
    }
  };
  const renewalTimer = setInterval(() => {
    void renewLease();
  }, leaseRenewalIntervalMs);
  try {
    const [encryptedCredentials] = await database
      .select({
        ciphertext: tenantConnection.credentialCiphertext,
        iv: tenantConnection.credentialIv,
        authTag: tenantConnection.credentialAuthTag,
        keyVersion: tenantConnection.credentialKeyVersion,
        workspaceId: tenantConnection.workspaceId,
      })
      .from(tenantConnection)
      .where(eq(tenantConnection.id, tenantConnectionId));
    if (!encryptedCredentials) {
      throw new Error("Tenant connection credentials are missing");
    }
    if (encryptedCredentials.keyVersion !== credentialKeyVersion) {
      throw new Error("Tenant connection credential key version does not match the worker cipher");
    }

    const credentials = cipher.decrypt(encryptedCredentials, {
      operation: "tenant_validation",
      workspaceId: encryptedCredentials.workspaceId,
    });
    let releasePermit: ReleaseMicrosoftWorkPermit | undefined;
    try {
      releasePermit = await limiter.acquire(claimed.tenantConnection.organizationId);
      if (leaseLost || !(await renewLease(now ?? new Date()))) {
        return { status: "lease_lost" as const };
      }

      let result: TenantValidationResult;
      try {
        result = tenantValidationResultSchema.parse(
          await provisioner.validateTenant({
            contractVersion: provisionerContractVersion,
            jobId,
            tenantConnectionId,
            credentials,
          }),
        );
      } catch {
        result = {
          code: "unexpected_failure" as const,
          contractVersion: "v1",
          retryable: true,
          status: "failure" as const,
        };
      }
      return await applyTenantValidationResult(database, jobId, leaseToken, result, now);
    } finally {
      releasePermit?.();
    }
  } catch {
    log.error({ action: "tenant_validation_job_result_failed", jobId, tenantConnectionId });
    throw new Error("Tenant validation job processing failed");
  } finally {
    clearInterval(renewalTimer);
  }
}

function createPgBossQueue(boss: PgBoss): TenantValidationQueue {
  return {
    async enqueue(jobId, options) {
      const result = await boss.send(
        tenantValidationQueueName,
        { jobId },
        {
          startAfter: options?.delayMs ? options.delayMs / 1_000 : undefined,
        },
      );
      if (!result) {
        throw new Error("Failed to enqueue tenant validation job");
      }
    },
    async register(handler) {
      await boss.work<{ jobId: string }>(
        tenantValidationQueueName,
        { localConcurrency: 5 },
        async (jobs) => {
          await Promise.all(
            jobs.map(async ({ data }) => {
              if (!data || typeof data.jobId !== "string") {
                log.error({ action: "tenant_validation_queue_payload_invalid" });
                return;
              }
              await handler(data.jobId);
            }),
          );
        },
      );
    },
  };
}

export async function createTenantValidationWorker({
  database,
  databaseUrl,
  cipher,
  credentialKeyVersion,
  provisioner,
  limiter = new MicrosoftWorkLimiter(),
}: Omit<ProcessTenantValidationJobInput, "jobId" | "queue" | "now"> & { databaseUrl: string }) {
  const boss = await new PgBoss(databaseUrl).start();
  await boss.createQueue(tenantValidationQueueName, { retryLimit: 0 });
  const queue = createPgBossQueue(boss);
  await queue.register(async (jobId) => {
    await processTenantValidationJob({
      database,
      cipher,
      credentialKeyVersion,
      provisioner,
      jobId,
      limiter,
    });
  });
  const tick = () =>
    runTenantValidationWorkerTick(database, queue).catch(() => {
      log.error({ action: "tenant_validation_worker_tick_failed" });
    });
  await runTenantValidationWorkerTick(database, queue);
  const interval = setInterval(tick, tenantValidationWorkerTickIntervalMs);

  return {
    boss,
    dispatchPendingOutbox: () => runTenantValidationWorkerTick(database, queue),
    stop: async () => {
      clearInterval(interval);
      await boss.stop();
    },
  };
}
