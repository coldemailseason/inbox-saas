import type {
  TenantValidationProvisioner,
  TenantValidationRequest,
  TenantValidationResult,
} from "@inbox-saas/provisioner-contract";

export type FakeTenantValidationInvocation = Pick<
  TenantValidationRequest,
  "contractVersion" | "jobId" | "tenantConnectionId"
>;

export class FakeTenantValidationProvisioner implements TenantValidationProvisioner {
  readonly invocations: FakeTenantValidationInvocation[] = [];

  constructor(
    private readonly result: TenantValidationResult,
    private readonly onValidate?: (request: TenantValidationRequest) => void | Promise<void>,
  ) {}

  async validateTenant(request: TenantValidationRequest): Promise<TenantValidationResult> {
    await this.onValidate?.(request);
    this.invocations.push({
      contractVersion: request.contractVersion,
      jobId: request.jobId,
      tenantConnectionId: request.tenantConnectionId,
    });
    return this.result;
  }
}
