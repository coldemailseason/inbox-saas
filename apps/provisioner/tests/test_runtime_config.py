import base64

import pytest

from inbox_provisioner.runtime_config import decode_signing_secret, decode_transport_encryption_key


def test_decode_signing_secret_accepts_a_base64_encoded_32_byte_value() -> None:
    secret = bytes(range(32))

    assert decode_signing_secret(base64.b64encode(secret).decode()) == secret


@pytest.mark.parametrize("value", ["not-base64", base64.b64encode(b"short").decode()])
def test_decode_signing_secret_rejects_malformed_or_wrong_length_values(value: str) -> None:
    with pytest.raises(ValueError, match="base64-encoded 32-byte key"):
        decode_signing_secret(value)


def test_decode_transport_encryption_key_rejects_malformed_or_wrong_length_values() -> None:
    key = bytes(range(32))

    assert decode_transport_encryption_key(base64.b64encode(key).decode()) == key
    with pytest.raises(ValueError, match="base64-encoded 32-byte key"):
        decode_transport_encryption_key("not-base64")
    with pytest.raises(ValueError, match="base64-encoded 32-byte key"):
        decode_transport_encryption_key(base64.b64encode(b"short").decode())
