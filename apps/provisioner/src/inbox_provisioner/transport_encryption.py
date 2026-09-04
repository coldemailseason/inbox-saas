import base64
import binascii

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import ValidationError

from .contracts import ProvisionerTransportEnvelope, TenantValidationRequest


def decrypt_tenant_validation_request(
    raw_envelope: bytes, transport_encryption_key: bytes
) -> TenantValidationRequest | None:
    try:
        envelope = ProvisionerTransportEnvelope.model_validate_json(raw_envelope)
        iv = base64.b64decode(envelope.iv, validate=True)
        ciphertext = base64.b64decode(envelope.ciphertext, validate=True)
        auth_tag = base64.b64decode(envelope.authTag, validate=True)
        if len(iv) != 12 or len(auth_tag) != 16 or not ciphertext:
            return None
        plaintext = AESGCM(transport_encryption_key).decrypt(iv, ciphertext + auth_tag, None)
        return TenantValidationRequest.model_validate_json(plaintext)
    except (binascii.Error, InvalidTag, UnicodeDecodeError, ValidationError, ValueError):
        return None
