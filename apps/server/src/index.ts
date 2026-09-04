import { auth } from "@inbox-saas/auth";
import { db } from "@inbox-saas/db";
import { createTenantCredentialCipher } from "@inbox-saas/product";
import { serve } from "@hono/node-server";
import { initLogger } from "evlog";

import { createApp } from "./app.js";

initLogger({
  env: { service: "inbox-saas-server" },
});

function createRuntimeCredentialCipher() {
  const encodedKey = process.env.TENANT_CREDENTIAL_ENCRYPTION_KEY;
  const keyVersion = process.env.TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION;
  if (!encodedKey || !keyVersion) {
    throw new Error(
      "TENANT_CREDENTIAL_ENCRYPTION_KEY and TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION must be configured",
    );
  }

  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey)) {
      throw new Error("Tenant credential encryption key is not base64");
    }
    return createTenantCredentialCipher({ key: Buffer.from(encodedKey, "base64"), keyVersion });
  } catch {
    throw new Error(
      "TENANT_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key and TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION must be non-empty",
    );
  }
}

const app = createApp({
  database: db,
  authInstance: auth,
  credentialCipher: createRuntimeCredentialCipher(),
});

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
