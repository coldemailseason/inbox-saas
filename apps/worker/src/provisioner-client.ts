import { randomUUID } from "node:crypto";

import {
  tenantValidationResultSchema,
  type TenantValidationProvisioner,
  type TenantValidationRequest,
  type TenantValidationResult,
} from "@inbox-saas/provisioner-contract";

import {
  inboxNonceHeader,
  inboxSignatureHeader,
  inboxTimestampHeader,
  signProvisionerRequest,
} from "./provisioner-request-auth.js";
import { encryptProvisionerRequest } from "./provisioner-transport-encryption.js";

const tenantValidationPath = "/internal/v1/tenant-validations";
const provisionerTimeoutMs = 270_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type HttpTenantValidationProvisionerOptions = {
  baseUrl: string;
  serviceSecret: Buffer;
  transportEncryptionKey: Buffer;
  fetch?: Fetch;
  clock?: () => Date;
  nonce?: () => string;
};

export class HttpTenantValidationProvisioner implements TenantValidationProvisioner {
  private readonly endpoint: string;
  private readonly fetch: Fetch;
  private readonly clock: () => Date;
  private readonly nonce: () => string;

  constructor({
    baseUrl,
    serviceSecret,
    transportEncryptionKey,
    fetch,
    clock,
    nonce,
  }: HttpTenantValidationProvisionerOptions) {
    if (serviceSecret.byteLength !== 32) {
      throw new Error("Provisioner service secret must be 32 bytes");
    }
    if (transportEncryptionKey.byteLength !== 32) {
      throw new Error("Provisioner transport encryption key must be 32 bytes");
    }

    this.endpoint = createTenantValidationEndpoint(baseUrl);
    this.serviceSecret = serviceSecret;
    this.transportEncryptionKey = transportEncryptionKey;
    this.fetch = fetch ?? globalThis.fetch;
    this.clock = clock ?? (() => new Date());
    this.nonce = nonce ?? randomUUID;
  }

  private readonly serviceSecret: Buffer;
  private readonly transportEncryptionKey: Buffer;

  async validateTenant(request: TenantValidationRequest): Promise<TenantValidationResult> {
    const body = JSON.stringify(encryptProvisionerRequest(this.transportEncryptionKey, request));
    const timestamp = Math.floor(this.clock().getTime() / 1_000).toString();
    const nonce = this.nonce();
    const signature = signProvisionerRequest(this.serviceSecret, timestamp, nonce, body);

    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [inboxTimestampHeader]: timestamp,
          [inboxNonceHeader]: nonce,
          [inboxSignatureHeader]: signature,
        },
        body,
        signal: AbortSignal.timeout(provisionerTimeoutMs),
      });
    } catch {
      throw new Error("Tenant validation provisioner request failed");
    }

    if (!response.ok) {
      throw new Error(`Tenant validation provisioner returned HTTP ${response.status}`);
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new Error("Tenant validation provisioner returned invalid JSON");
    }

    const parsed = tenantValidationResultSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new Error("Tenant validation provisioner returned an invalid result");
    }

    return parsed.data;
  }
}

function createTenantValidationEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Provisioner base URL is invalid");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provisioner base URL must use HTTP or HTTPS");
  }

  if (url.username || url.password) {
    throw new Error("Provisioner base URL must not include credentials");
  }

  return new URL(tenantValidationPath, url).toString();
}
