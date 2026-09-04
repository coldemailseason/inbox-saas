export type FakeTenantValidationWorkerConfig = {
  databaseUrl: string;
  credentialKey: Buffer;
  credentialKeyVersion: string;
  microsoftTenantId: string;
};

export type TenantValidationWorkerConfig = {
  databaseUrl: string;
  credentialKey: Buffer;
  credentialKeyVersion: string;
  provisionerBaseUrl: string;
  provisionerSigningSecret: Buffer;
  provisionerTransportEncryptionKey: Buffer;
};

function requiredValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value?.trim()) {
    throw new Error(`${name} must be configured`);
  }

  return value;
}

function parseDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error("Database URL must use PostgreSQL");
    }
    return value;
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
}

function parseProvisionerBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error("Invalid provisioner URL");
    }
    return value;
  } catch {
    throw new Error("PROVISIONER_BASE_URL must be a valid HTTP or HTTPS URL without credentials");
  }
}

function parseCredentialKey(encodedKey: string): Buffer {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey)) {
      throw new Error("Tenant credential encryption key is not base64");
    }

    const credentialKey = Buffer.from(encodedKey, "base64");
    if (credentialKey.byteLength !== 32) {
      throw new Error("Tenant credential encryption key is not 32 bytes");
    }
    return credentialKey;
  } catch {
    throw new Error(
      "TENANT_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key and TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION must be non-empty",
    );
  }
}

function parseProvisionerSigningSecret(encodedSecret: string): Buffer {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedSecret)) {
      throw new Error("Provisioner signing secret is not base64");
    }

    const signingSecret = Buffer.from(encodedSecret, "base64");
    if (signingSecret.byteLength !== 32) {
      throw new Error("Provisioner signing secret is not 32 bytes");
    }
    return signingSecret;
  } catch {
    throw new Error("INBOX_PROVISIONER_SIGNING_SECRET must be a base64-encoded 32-byte key");
  }
}

function parseProvisionerTransportEncryptionKey(encodedKey: string): Buffer {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey)) {
      throw new Error("Provisioner transport encryption key is not base64");
    }

    const transportEncryptionKey = Buffer.from(encodedKey, "base64");
    if (transportEncryptionKey.byteLength !== 32) {
      throw new Error("Provisioner transport encryption key is not 32 bytes");
    }
    return transportEncryptionKey;
  } catch {
    throw new Error(
      "INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }
}

export function parseTenantValidationWorkerConfig(
  environment: NodeJS.ProcessEnv,
): TenantValidationWorkerConfig {
  const databaseUrl = parseDatabaseUrl(requiredValue(environment, "DATABASE_URL"));
  const encodedKey = requiredValue(environment, "TENANT_CREDENTIAL_ENCRYPTION_KEY");
  const credentialKeyVersion = requiredValue(
    environment,
    "TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION",
  );
  const provisionerBaseUrl = parseProvisionerBaseUrl(
    requiredValue(environment, "PROVISIONER_BASE_URL"),
  );
  const provisionerSigningSecret = parseProvisionerSigningSecret(
    requiredValue(environment, "INBOX_PROVISIONER_SIGNING_SECRET"),
  );
  const provisionerTransportEncryptionKey = parseProvisionerTransportEncryptionKey(
    requiredValue(environment, "INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY"),
  );
  const credentialKey = parseCredentialKey(encodedKey);

  return {
    databaseUrl,
    credentialKey,
    credentialKeyVersion,
    provisionerBaseUrl,
    provisionerSigningSecret,
    provisionerTransportEncryptionKey,
  };
}

export function parseFakeTenantValidationWorkerConfig(
  environment: NodeJS.ProcessEnv,
): FakeTenantValidationWorkerConfig {
  if (environment.NODE_ENV === "production") {
    throw new Error("The fake tenant-validation worker cannot run in production");
  }

  if (environment.TENANT_VALIDATION_PROVISIONER !== "fake") {
    throw new Error("TENANT_VALIDATION_PROVISIONER must be set to fake");
  }

  const databaseUrl = parseDatabaseUrl(requiredValue(environment, "DATABASE_URL"));
  const encodedKey = requiredValue(environment, "TENANT_CREDENTIAL_ENCRYPTION_KEY");
  const credentialKeyVersion = requiredValue(
    environment,
    "TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION",
  );
  const microsoftTenantId = requiredValue(environment, "FAKE_MICROSOFT_TENANT_ID");

  const credentialKey = parseCredentialKey(encodedKey);
  return { databaseUrl, credentialKey, credentialKeyVersion, microsoftTenantId };
}
