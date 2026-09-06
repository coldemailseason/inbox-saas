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

function parseBase64Key(encodedValue: string, errorMessage: string): Buffer {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedValue)) {
      throw new Error("Value is not base64");
    }

    const key = Buffer.from(encodedValue, "base64");
    if (key.byteLength !== 32) {
      throw new Error("Value is not 32 bytes");
    }
    return key;
  } catch {
    throw new Error(errorMessage);
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
  const provisionerSigningSecret = parseBase64Key(
    requiredValue(environment, "INBOX_PROVISIONER_SIGNING_SECRET"),
    "INBOX_PROVISIONER_SIGNING_SECRET must be a base64-encoded 32-byte key",
  );
  const provisionerTransportEncryptionKey = parseBase64Key(
    requiredValue(environment, "INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY"),
    "INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
  );
  const credentialKey = parseBase64Key(
    encodedKey,
    "TENANT_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key and TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION must be non-empty",
  );

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

  const credentialKey = parseBase64Key(
    encodedKey,
    "TENANT_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key and TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION must be non-empty",
  );
  return { databaseUrl, credentialKey, credentialKeyVersion, microsoftTenantId };
}
