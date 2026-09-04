import * as schema from "@inbox-saas/db/schema";
import { createTenantCredentialCipher } from "@inbox-saas/product/tenant-credentials";
import { drizzle } from "drizzle-orm/node-postgres";
import { initLogger, log } from "evlog";

import { FakeTenantValidationProvisioner } from "./fake-provisioner.js";
import { parseFakeTenantValidationWorkerConfig } from "./runtime-config.js";
import { createTenantValidationWorker } from "./tenant-validation-worker.js";

async function start(): Promise<void> {
  const config = parseFakeTenantValidationWorkerConfig(process.env);

  initLogger({
    env: { service: "inbox-saas-worker" },
  });

  const database = drizzle(config.databaseUrl, { schema });
  const cipher = createTenantCredentialCipher({
    key: config.credentialKey,
    keyVersion: config.credentialKeyVersion,
  });
  const provisioner = new FakeTenantValidationProvisioner({
    contractVersion: "v1",
    status: "success",
    microsoftTenantId: config.microsoftTenantId,
  });
  const worker = await createTenantValidationWorker({
    database,
    databaseUrl: config.databaseUrl,
    cipher,
    credentialKeyVersion: config.credentialKeyVersion,
    provisioner,
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;

    try {
      await worker.stop();
      log.info({ action: "tenant_validation_worker_stopped" });
    } catch {
      process.exitCode = 1;
      log.error({ action: "tenant_validation_worker_stop_failed" });
    }
  };

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  log.info({ action: "tenant_validation_worker_started", provisioner: "fake" });
}

void start().catch((error: unknown) => {
  process.exitCode = 1;
  console.error(
    error instanceof Error ? error.message : "Fake tenant-validation worker failed to start",
  );
});
