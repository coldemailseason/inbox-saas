import { createCipheriv, randomBytes } from "node:crypto";

import type { TenantValidationRequest } from "@inbox-saas/provisioner-contract";

export type ProvisionerTransportEnvelope = {
  iv: string;
  ciphertext: string;
  authTag: string;
};

export function encryptProvisionerRequest(
  key: Buffer,
  request: TenantValidationRequest,
): ProvisionerTransportEnvelope {
  if (key.byteLength !== 32) {
    throw new Error("Provisioner transport encryption key must be 32 bytes");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(request), "utf8"),
    cipher.final(),
  ]);

  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}
