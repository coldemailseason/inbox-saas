import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";

const tenantCredentialsSchema = z.object({
  email: z.string(),
  password: z.string(),
});

export type TenantCredentials = {
  email: string;
  password: string;
};

export type EncryptedTenantCredentials = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: string;
};

export type TenantCredentialFingerprintInput = TenantCredentials & {
  workspaceId: string;
  operation: "tenant_validation";
};

export type TenantCredentialContext = {
  workspaceId: string;
  operation: "tenant_validation";
};

export interface TenantCredentialCipher {
  encrypt(
    credentials: TenantCredentials,
    context: TenantCredentialContext,
  ): EncryptedTenantCredentials;
  decrypt(
    credentials: EncryptedTenantCredentials,
    context: TenantCredentialContext,
  ): TenantCredentials;
  fingerprint(input: TenantCredentialFingerprintInput): string;
}

function validateKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) {
    throw new Error("Tenant credential cipher key must be exactly 32 bytes");
  }

  return Buffer.from(key);
}

function updateEncodedField(hmac: ReturnType<typeof createHmac>, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(encoded.length);
  hmac.update(length);
  hmac.update(encoded);
}

function credentialAdditionalAuthenticatedData(context: TenantCredentialContext): Buffer {
  const chunks = [Buffer.from("inbox-saas:tenant-credentials:v1\0", "utf8")];
  for (const value of [context.workspaceId, context.operation]) {
    const encoded = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.length);
    chunks.push(length, encoded);
  }
  return Buffer.concat(chunks);
}

export function fingerprintTenantValidationPayload(
  key: Uint8Array,
  input: TenantCredentialFingerprintInput,
): string {
  const hmac = createHmac("sha256", validateKey(key));
  hmac.update("inbox-saas:tenant-validation-payload:v1\0", "utf8");
  updateEncodedField(hmac, input.workspaceId);
  updateEncodedField(hmac, input.operation);
  updateEncodedField(hmac, input.email);
  updateEncodedField(hmac, input.password);
  return hmac.digest("hex");
}

export function createTenantCredentialCipher({
  key,
  keyVersion,
}: {
  key: Uint8Array;
  keyVersion: string;
}): TenantCredentialCipher {
  const cipherKey = validateKey(key);

  if (keyVersion.trim() === "") {
    throw new Error("Tenant credential cipher key version is required");
  }

  return {
    encrypt(credentials, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", cipherKey, iv);
      cipher.setAAD(credentialAdditionalAuthenticatedData(context));
      const ciphertext = Buffer.concat([
        cipher.update(
          JSON.stringify({ email: credentials.email, password: credentials.password }),
          "utf8",
        ),
        cipher.final(),
      ]);

      return { authTag: cipher.getAuthTag(), ciphertext, iv, keyVersion };
    },
    decrypt(credentials, context) {
      const decipher = createDecipheriv("aes-256-gcm", cipherKey, credentials.iv);
      decipher.setAAD(credentialAdditionalAuthenticatedData(context));
      decipher.setAuthTag(credentials.authTag);
      const plaintext = Buffer.concat([decipher.update(credentials.ciphertext), decipher.final()]);
      const parsed = tenantCredentialsSchema.safeParse(JSON.parse(plaintext.toString("utf8")));
      if (!parsed.success) {
        throw new Error("Tenant credential ciphertext is invalid");
      }

      return parsed.data;
    },
    fingerprint(input) {
      return fingerprintTenantValidationPayload(cipherKey, input);
    },
  };
}
