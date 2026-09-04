import asyncio
import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi.testclient import TestClient

from inbox_provisioner.app import TenantValidationService, create_app
from inbox_provisioner.contracts import (
    TenantValidationFailure,
    TenantValidationRequest,
    TenantValidationResult,
    TenantValidationSuccess,
)

SECRET = bytes(range(32))
TRANSPORT_ENCRYPTION_KEY = bytes(range(32))
NOW = datetime(2026, 1, 1, tzinfo=UTC)
PATH = "/internal/v1/tenant-validations"
PASSWORD = "private-password"


class StubService(TenantValidationService):
    def __init__(self, result: TenantValidationResult | Exception) -> None:
        self.result = result
        self.requests: list[TenantValidationRequest] = []

    async def validate(self, request: TenantValidationRequest) -> TenantValidationResult:
        self.requests.append(request)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def plaintext_request(**changes: object) -> bytes:
    request = {
        "contractVersion": "v1",
        "jobId": "job-1",
        "tenantConnectionId": "connection-1",
        "credentials": {"email": "admin@example.com", "password": PASSWORD},
    }
    request.update(changes)
    return json.dumps(request, separators=(",", ":")).encode()


def request_body(**changes: object) -> bytes:
    iv = bytes(range(12))
    encrypted = AESGCM(TRANSPORT_ENCRYPTION_KEY).encrypt(iv, plaintext_request(**changes), None)
    return json.dumps(
        {
            "iv": base64.b64encode(iv).decode(),
            "ciphertext": base64.b64encode(encrypted[:-16]).decode(),
            "authTag": base64.b64encode(encrypted[-16:]).decode(),
        },
        separators=(",", ":"),
    ).encode()


def signed_headers(
    body: bytes, nonce: str = "nonce-1", timestamp: int | None = None
) -> dict[str, str]:
    value = str(timestamp if timestamp is not None else int(NOW.timestamp()))
    canonical = f"{value}\n{nonce}\n{hashlib.sha256(body).hexdigest()}".encode()
    signature = hmac.new(SECRET, canonical, hashlib.sha256).hexdigest()
    return {
        "X-Inbox-Timestamp": value,
        "X-Inbox-Nonce": nonce,
        "X-Inbox-Signature": signature,
    }


def client_for(result: TenantValidationResult | Exception) -> tuple[TestClient, StubService]:
    service = StubService(result)
    app = create_app(
        signing_secret=SECRET,
        transport_encryption_key=TRANSPORT_ENCRYPTION_KEY,
        service=service,
        clock=lambda: NOW,
    )
    return TestClient(app), service


def test_healthz() -> None:
    client, _ = client_for(TenantValidationFailure(
        contractVersion="v1", status="failure", code="unexpected_failure", retryable=True
    ))
    assert client.get("/healthz").json() == {"status": "ok"}


def test_valid_signed_request_calls_service() -> None:
    result = TenantValidationSuccess(
        contractVersion="v1", status="success", microsoftTenantId="tenant-1"
    )
    client, service = client_for(result)
    body = request_body()

    response = client.post(PATH, content=body, headers=signed_headers(body))

    assert response.status_code == 200
    assert service.requests[0].credentials.password == PASSWORD


def test_accepts_a_typescript_compatible_aes_gcm_envelope() -> None:
    result = TenantValidationSuccess(
        contractVersion="v1", status="success", microsoftTenantId="tenant-1"
    )
    client, service = client_for(result)
    body = (
        b'{"iv":"AAECAwQFBgcICQoL","ciphertext":"PCC1dKuRsHruNcHuw5oRAu30vRaGSn1QGg2K51QNIogjesGegvAwtFbQGoPp6Vx7gTcO6DmiyrVR3k47IsGWgZ5SoxmnuEkPMWWIQs3sfI1c76cWHwI/G9/H5e4dndjkp9pjxMUlpXPwXFvKKRhRE99JAcSO5wm4PZ4kvvWJHGqZaCK2xr69MnyEZdFcqT+1WYaHF0hs","authTag":"xH4q57ORYM1xh6MDD/Tiiw=="}'
    )

    response = client.post(PATH, content=body, headers=signed_headers(body))

    assert response.status_code == 200
    assert service.requests[0].credentials.password == PASSWORD


def test_tampered_envelope_and_wrong_key_are_rejected() -> None:
    body = request_body()
    tampered = json.loads(body)
    tampered["ciphertext"] = tampered["ciphertext"][:-1] + "A"
    tampered_body = json.dumps(tampered, separators=(",", ":")).encode()
    client, service = client_for(TenantValidationFailure(
        contractVersion="v1", status="failure", code="unexpected_failure", retryable=True
    ))
    wrong_key_app = create_app(
        signing_secret=SECRET,
        transport_encryption_key=bytes(32),
        service=StubService(TenantValidationFailure(
            contractVersion="v1", status="failure", code="unexpected_failure", retryable=True
        )),
        clock=lambda: NOW,
    )

    tampered_response = client.post(
        PATH, content=tampered_body, headers=signed_headers(tampered_body, nonce="tampered")
    )
    wrong_key_response = TestClient(wrong_key_app).post(
        PATH, content=body, headers=signed_headers(body, nonce="wrong-key")
    )

    assert tampered_response.status_code == 400
    assert wrong_key_response.status_code == 400
    assert not service.requests


def test_missing_or_bad_signature_is_rejected() -> None:
    client, service = client_for(TenantValidationFailure(
        contractVersion="v1", status="failure", code="unexpected_failure", retryable=True
    ))
    body = request_body()

    missing = client.post(PATH, content=body)
    bad_headers = signed_headers(body, nonce="nonce-2")
    bad_headers["X-Inbox-Signature"] = "0" * 64
    bad = client.post(PATH, content=body, headers=bad_headers)

    assert missing.status_code == 401
    assert bad.status_code == 401
    assert not service.requests


def test_stale_and_replayed_requests_are_rejected() -> None:
    client, service = client_for(TenantValidationFailure(
        contractVersion="v1", status="failure", code="unexpected_failure", retryable=True
    ))
    body = request_body()

    stale_headers = signed_headers(body, timestamp=int(NOW.timestamp()) - 301)
    stale = client.post(PATH, content=body, headers=stale_headers)
    first = client.post(PATH, content=body, headers=signed_headers(body, nonce="replayed"))
    replay = client.post(PATH, content=body, headers=signed_headers(body, nonce="replayed"))

    assert stale.status_code == 401
    assert first.status_code == 200
    assert replay.status_code == 401
    assert len(service.requests) == 1


def test_unknown_request_fields_are_rejected_without_exposure() -> None:
    client, _ = client_for(TenantValidationFailure(
        contractVersion="v1", status="failure", code="unexpected_failure", retryable=True
    ))
    body = request_body(diagnostic=PASSWORD)

    response = client.post(PATH, content=body, headers=signed_headers(body))

    assert response.status_code == 400
    assert PASSWORD not in response.text


def test_safe_success_and_failure_responses() -> None:
    success_client, _ = client_for(TenantValidationSuccess(
        contractVersion="v1", status="success", microsoftTenantId="tenant-1"
    ))
    failure_client, _ = client_for(TenantValidationFailure(
        contractVersion="v1", status="failure", code="invalid_credentials", retryable=False
    ))
    body = request_body()

    success = success_client.post(PATH, content=body, headers=signed_headers(body, nonce="success"))
    failure = failure_client.post(PATH, content=body, headers=signed_headers(body, nonce="failure"))

    assert success.json() == {
        "contractVersion": "v1",
        "status": "success",
        "microsoftTenantId": "tenant-1",
    }
    assert failure.json() == {
        "contractVersion": "v1",
        "status": "failure",
        "code": "invalid_credentials",
        "retryable": False,
    }
    assert PASSWORD not in success.text
    assert PASSWORD not in failure.text


def test_service_exception_has_no_secret_exposure() -> None:
    client, _ = client_for(RuntimeError(f"failed with {PASSWORD}"))
    body = request_body()

    response = client.post(PATH, content=body, headers=signed_headers(body))

    assert response.status_code == 500
    assert PASSWORD not in response.text


def test_declared_oversized_body_is_rejected_before_authentication() -> None:
    client, service = client_for(TenantValidationFailure(
        contractVersion="v1", status="failure", code="unexpected_failure", retryable=True
    ))

    response = client.post(PATH, content=b"x" * 4097)

    assert response.status_code == 413
    assert response.content == b""
    assert not service.requests


def test_chunked_oversized_body_is_rejected_without_full_buffering() -> None:
    app = create_app(
        signing_secret=SECRET,
        transport_encryption_key=TRANSPORT_ENCRYPTION_KEY,
        service=StubService(TenantValidationFailure(
            contractVersion="v1", status="failure", code="unexpected_failure", retryable=True
        )),
        clock=lambda: NOW,
    )

    async def chunks():
        yield b"x" * 2048
        yield b"x" * 2049

    async def scenario() -> None:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(PATH, content=chunks())
        assert response.status_code == 413
        assert response.content == b""

    asyncio.run(scenario())
