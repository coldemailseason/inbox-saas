from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, TypeAdapter


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class TenantCredentials(StrictModel):
    email: EmailStr = Field(max_length=254)
    password: str = Field(min_length=1, max_length=1024)


class TenantValidationRequest(StrictModel):
    contractVersion: Literal["v1"]
    jobId: str = Field(min_length=1, max_length=36)
    tenantConnectionId: str = Field(min_length=1, max_length=36)
    credentials: TenantCredentials


class ProvisionerTransportEnvelope(StrictModel):
    iv: str = Field(min_length=16, max_length=16)
    ciphertext: str = Field(min_length=4, max_length=4096)
    authTag: str = Field(min_length=24, max_length=24)


class TenantValidationSuccess(StrictModel):
    contractVersion: Literal["v1"]
    status: Literal["success"]
    microsoftTenantId: str = Field(min_length=1)


class TenantValidationFailure(StrictModel):
    contractVersion: Literal["v1"]
    status: Literal["failure"]
    code: Literal[
        "invalid_credentials",
        "authentication_challenge",
        "microsoft_unavailable",
        "unexpected_failure",
    ]
    retryable: bool


TenantValidationResult = Annotated[
    TenantValidationSuccess | TenantValidationFailure,
    Field(discriminator="status"),
]
tenant_validation_result_adapter = TypeAdapter(TenantValidationResult)
