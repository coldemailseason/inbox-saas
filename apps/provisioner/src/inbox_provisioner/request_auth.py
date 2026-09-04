import hashlib
import hmac
import re
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

MAX_REQUEST_AGE_SECONDS = 300
MAX_NONCE_LENGTH = 256
_TIMESTAMP_PATTERN = re.compile(r"^[0-9]{1,16}$")


@dataclass(frozen=True)
class VerifiedRequest:
    nonce: str
    nonce_expires_at: float
    verified_at: float


class InMemoryNonceStore:
    """Retains accepted nonces for the request validity window without evicting live entries."""

    def __init__(self, max_entries: int = 10_000) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be positive")
        self._max_entries = max_entries
        self._nonces: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()

    def check_and_store(self, nonce: str, expires_at: float, now: float) -> bool:
        with self._lock:
            for stored_nonce, expiry in tuple(self._nonces.items()):
                if expiry <= now:
                    del self._nonces[stored_nonce]
            if nonce in self._nonces or len(self._nonces) >= self._max_entries:
                return False
            self._nonces[nonce] = expires_at
            return True


def verify_signed_request(
    *,
    raw_body: bytes,
    timestamp: str | None,
    nonce: str | None,
    signature: str | None,
    secret: bytes,
    clock: Callable[[], datetime],
) -> VerifiedRequest | None:
    """Verify a signed private request without parsing its untrusted JSON body."""
    if not secret or not timestamp or not nonce or not signature:
        return None
    if not _TIMESTAMP_PATTERN.fullmatch(timestamp) or len(nonce) > MAX_NONCE_LENGTH:
        return None
    if len(signature) != 64 or any(character not in "0123456789abcdef" for character in signature):
        return None

    request_timestamp = int(timestamp)
    now = clock().astimezone(UTC).timestamp()
    if abs(now - request_timestamp) > MAX_REQUEST_AGE_SECONDS:
        return None

    body_hash = hashlib.sha256(raw_body).hexdigest()
    canonical_input = f"{timestamp}\n{nonce}\n{body_hash}".encode()
    expected_signature = hmac.new(secret, canonical_input, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_signature, signature):
        return None

    return VerifiedRequest(
        nonce=nonce,
        nonce_expires_at=request_timestamp + MAX_REQUEST_AGE_SECONDS,
        verified_at=now,
    )
