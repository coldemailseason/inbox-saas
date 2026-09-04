from collections.abc import Callable
from datetime import UTC, datetime
from typing import Protocol

from fastapi import FastAPI, Request, Response

from .contracts import (
    TenantValidationFailure,
    TenantValidationRequest,
    TenantValidationResult,
    tenant_validation_result_adapter,
)
from .request_auth import InMemoryNonceStore, verify_signed_request
from .transport_encryption import decrypt_tenant_validation_request

TENANT_VALIDATION_MAX_BODY_BYTES = 4 * 1024


class TenantValidationService(Protocol):
    async def validate(self, request: TenantValidationRequest) -> TenantValidationResult: ...


class UnavailableTenantValidationService:
    async def validate(self, request: TenantValidationRequest) -> TenantValidationResult:
        return TenantValidationFailure(
            contractVersion="v1",
            status="failure",
            code="unexpected_failure",
            retryable=True,
        )


def create_app(
    *,
    signing_secret: bytes,
    transport_encryption_key: bytes,
    service: TenantValidationService | None = None,
    clock: Callable[[], datetime] | None = None,
    nonce_store: InMemoryNonceStore | None = None,
    headless_browser: bool | None = None,
) -> FastAPI:
    if len(signing_secret) != 32:
        raise ValueError("signing_secret must be 32 bytes")
    if len(transport_encryption_key) != 32:
        raise ValueError("transport_encryption_key must be 32 bytes")

    app = FastAPI()
    if service is not None:
        validation_service = service
    elif headless_browser is None:
        validation_service = UnavailableTenantValidationService()
    else:
        from .tenant_validation import RealTenantValidationService

        validation_service = RealTenantValidationService(headless_browser=headless_browser)
    request_clock = clock or (lambda: datetime.now(UTC))
    used_nonces = nonce_store or InMemoryNonceStore()

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/internal/v1/tenant-validations")
    async def validate_tenant(request: Request) -> Response:
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > TENANT_VALIDATION_MAX_BODY_BYTES:
                    return Response(status_code=413)
            except ValueError:
                pass

        raw_body = await _read_bounded_body(request)
        if raw_body is None:
            return Response(status_code=413)
        verified_request = verify_signed_request(
            raw_body=raw_body,
            timestamp=request.headers.get("X-Inbox-Timestamp"),
            nonce=request.headers.get("X-Inbox-Nonce"),
            signature=request.headers.get("X-Inbox-Signature"),
            secret=signing_secret,
            clock=request_clock,
        )
        if verified_request is None or not used_nonces.check_and_store(
            verified_request.nonce,
            expires_at=verified_request.nonce_expires_at,
            now=verified_request.verified_at,
        ):
            return Response(status_code=401)

        tenant_request = decrypt_tenant_validation_request(raw_body, transport_encryption_key)
        if tenant_request is None:
            return Response(status_code=400)

        try:
            service_result = await validation_service.validate(tenant_request)
            validated_result = tenant_validation_result_adapter.validate_python(service_result)
        except Exception:
            return Response(status_code=500)

        return Response(
            content=validated_result.model_dump_json(),
            media_type="application/json",
        )

    return app


async def _read_bounded_body(request: Request) -> bytes | None:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > TENANT_VALIDATION_MAX_BODY_BYTES:
            return None
        chunks.append(chunk)
    return b"".join(chunks)
