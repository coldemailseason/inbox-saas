import { z } from "zod";

export const provisionerContractVersion = "v1";

export const provisionerContractVersionSchema = z.literal(provisionerContractVersion);

export type ProvisionerContractVersion = z.infer<typeof provisionerContractVersionSchema>;

export const tenantValidationFailureCodeSchema = z.enum([
  "invalid_credentials",
  "authentication_challenge",
  "microsoft_unavailable",
  "unexpected_failure",
]);

export type TenantValidationFailureCode = z.infer<typeof tenantValidationFailureCodeSchema>;

export const tenantValidationRequestSchema = z.strictObject({
  contractVersion: provisionerContractVersionSchema,
  jobId: z.string().min(1),
  tenantConnectionId: z.string().min(1),
  credentials: z.strictObject({
    email: z.email(),
    password: z.string().min(1),
  }),
});

const tenantValidationSuccessResultSchema = z.strictObject({
  contractVersion: provisionerContractVersionSchema,
  status: z.literal("success"),
  microsoftTenantId: z.string().min(1),
});

const tenantValidationFailureResultSchema = z.strictObject({
  contractVersion: provisionerContractVersionSchema,
  status: z.literal("failure"),
  code: tenantValidationFailureCodeSchema,
  retryable: z.boolean(),
});

export const tenantValidationResultSchema = z.discriminatedUnion("status", [
  tenantValidationSuccessResultSchema,
  tenantValidationFailureResultSchema,
]);

export type TenantValidationRequest = z.infer<typeof tenantValidationRequestSchema>;

export type TenantValidationResult = z.infer<typeof tenantValidationResultSchema>;

export interface TenantValidationProvisioner {
  validateTenant(request: TenantValidationRequest): Promise<TenantValidationResult>;
}
