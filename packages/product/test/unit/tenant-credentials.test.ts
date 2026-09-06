import { randomBytes } from "node:crypto";

import {
  createTenantCredentialCipher,
  fingerprintTenantValidationPayload,
} from "../../src/tenant-credentials.js";
import { describe, expect, it } from "vitest";

describe("tenant credential cipher", () => {
  const key = randomBytes(32);

  it("round trips credentials without retaining plaintext in ciphertext", () => {
    const cipher = createTenantCredentialCipher({ key, keyVersion: "test-v1" });
    const credentials = { email: "tenant-admin@example.test", password: "private-password" };
    const context = { operation: "tenant_validation" as const, workspaceId: "workspace-1" };
    const encrypted = cipher.encrypt(credentials, context);

    expect(cipher.decrypt(encrypted, context)).toEqual(credentials);
    expect(encrypted.ciphertext.toString("utf8")).not.toContain(credentials.email);
    expect(encrypted.ciphertext.toString("utf8")).not.toContain(credentials.password);
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(
      fingerprintTenantValidationPayload(key, {
        ...credentials,
        operation: "tenant_validation",
        workspaceId: "workspace-1",
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() =>
      createTenantCredentialCipher({ key: randomBytes(31), keyVersion: "test-v1" }),
    ).toThrow("exactly 32 bytes");
  });

  it("rejects whitespace-only key versions", () => {
    expect(() => createTenantCredentialCipher({ key, keyVersion: " \t\n" })).toThrow(
      "Tenant credential cipher key version is required",
    );
  });

  it("rejects tampered encrypted binary data", () => {
    const cipher = createTenantCredentialCipher({ key, keyVersion: "test-v1" });
    const context = { operation: "tenant_validation" as const, workspaceId: "workspace-1" };
    const encrypted = cipher.encrypt(
      {
        email: "tenant-admin@example.test",
        password: "private-password",
      },
      context,
    );
    encrypted.authTag[0] = (encrypted.authTag[0] ?? 0) ^ 1;

    expect(() => cipher.decrypt(encrypted, context)).toThrow();
  });

  it("rejects authenticated plaintext with an invalid credential shape", () => {
    const cipher = createTenantCredentialCipher({ key, keyVersion: "test-v1" });
    const context = { operation: "tenant_validation" as const, workspaceId: "workspace-1" };
    const malformedCredentials = {
      email: "tenant-admin@example.test",
      password: "private-password",
    };
    Object.defineProperty(malformedCredentials, "password", { value: 42 });
    const encrypted = cipher.encrypt(malformedCredentials, context);

    expect(() => cipher.decrypt(encrypted, context)).toThrow(
      "Tenant credential ciphertext is invalid",
    );
  });

  it("rejects credentials encrypted for another workspace context", () => {
    const cipher = createTenantCredentialCipher({ key, keyVersion: "test-v1" });
    const encrypted = cipher.encrypt(
      { email: "tenant-admin@example.test", password: "private-password" },
      { operation: "tenant_validation", workspaceId: "workspace-1" },
    );

    expect(() =>
      cipher.decrypt(encrypted, { operation: "tenant_validation", workspaceId: "workspace-2" }),
    ).toThrow();
  });
});
