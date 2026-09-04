import { describe, expect, it } from "vitest";

import {
  parseFakeTenantValidationWorkerConfig,
  parseTenantValidationWorkerConfig,
} from "../../src/runtime-config.js";

const validRealEnvironment = {
  DATABASE_URL: "postgresql://localhost:5432/inbox_saas",
  TENANT_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION: "test-v1",
  PROVISIONER_BASE_URL: "http://provisioner:8000",
  INBOX_PROVISIONER_SIGNING_SECRET: Buffer.alloc(32, 9).toString("base64"),
  INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY: Buffer.alloc(32, 10).toString("base64"),
};

const validFakeEnvironment = {
  ...validRealEnvironment,
  TENANT_VALIDATION_PROVISIONER: "fake",
  FAKE_MICROSOFT_TENANT_ID: "fake-tenant-id",
};

describe("parseTenantValidationWorkerConfig", () => {
  it("accepts complete real-worker configuration", () => {
    expect(parseTenantValidationWorkerConfig(validRealEnvironment)).toMatchObject({
      databaseUrl: validRealEnvironment.DATABASE_URL,
      credentialKeyVersion: validRealEnvironment.TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION,
      provisionerBaseUrl: validRealEnvironment.PROVISIONER_BASE_URL,
      provisionerSigningSecret: Buffer.from(
        validRealEnvironment.INBOX_PROVISIONER_SIGNING_SECRET,
        "base64",
      ),
      provisionerTransportEncryptionKey: Buffer.from(
        validRealEnvironment.INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY,
        "base64",
      ),
    });
  });

  it.each([
    ["DATABASE_URL", "DATABASE_URL must be configured"],
    ["TENANT_CREDENTIAL_ENCRYPTION_KEY", "TENANT_CREDENTIAL_ENCRYPTION_KEY must be configured"],
    [
      "TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION",
      "TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION must be configured",
    ],
    ["PROVISIONER_BASE_URL", "PROVISIONER_BASE_URL must be configured"],
    ["INBOX_PROVISIONER_SIGNING_SECRET", "INBOX_PROVISIONER_SIGNING_SECRET must be configured"],
    [
      "INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY",
      "INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY must be configured",
    ],
  ])("fails closed when %s is missing", (name, message) => {
    const environment = { ...validRealEnvironment, [name]: "" };
    expect(() => parseTenantValidationWorkerConfig(environment)).toThrow(message);
  });

  it.each([
    ["DATABASE_URL", "mysql://localhost/inbox_saas", "DATABASE_URL must be a valid PostgreSQL URL"],
    ["TENANT_CREDENTIAL_ENCRYPTION_KEY", "not-base64", "base64-encoded 32-byte key"],
    [
      "TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION",
      "   ",
      "TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION must be configured",
    ],
    ["PROVISIONER_BASE_URL", "ftp://provisioner", "valid HTTP or HTTPS URL"],
    ["INBOX_PROVISIONER_SIGNING_SECRET", "not-base64", "base64-encoded 32-byte key"],
    [
      "INBOX_PROVISIONER_SIGNING_SECRET",
      Buffer.alloc(31).toString("base64"),
      "base64-encoded 32-byte key",
    ],
    ["INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY", "not-base64", "base64-encoded 32-byte key"],
    [
      "INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY",
      Buffer.alloc(31).toString("base64"),
      "base64-encoded 32-byte key",
    ],
  ])("fails closed when %s is invalid", (name, value, message) => {
    expect(() =>
      parseTenantValidationWorkerConfig({ ...validRealEnvironment, [name]: value }),
    ).toThrow(message);
  });
});

describe("parseFakeTenantValidationWorkerConfig", () => {
  it("rejects production before evaluating fake-worker configuration", () => {
    expect(() => parseFakeTenantValidationWorkerConfig({ NODE_ENV: "production" })).toThrow(
      "cannot run in production",
    );
  });

  it("requires an explicit fake provisioner selection", () => {
    expect(() => parseFakeTenantValidationWorkerConfig(validFakeEnvironment)).not.toThrow();
    expect(() =>
      parseFakeTenantValidationWorkerConfig({
        ...validFakeEnvironment,
        TENANT_VALIDATION_PROVISIONER: "real",
      }),
    ).toThrow("TENANT_VALIDATION_PROVISIONER must be set to fake");
  });

  it("fails closed for missing or malformed required configuration", () => {
    expect(() => {
      const { DATABASE_URL: _, ...environment } = validFakeEnvironment;
      return parseFakeTenantValidationWorkerConfig(environment);
    }).toThrow("DATABASE_URL must be configured");

    expect(() =>
      parseFakeTenantValidationWorkerConfig({
        ...validFakeEnvironment,
        TENANT_CREDENTIAL_ENCRYPTION_KEY: "not-base64",
      }),
    ).toThrow("base64-encoded 32-byte key");
  });
});
