import base64
import binascii


def decode_32_byte_key(encoded_key: str, environment_name: str) -> bytes:
    try:
        key = base64.b64decode(encoded_key, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError(
            f"{environment_name} must be a base64-encoded 32-byte key"
        ) from error

    if len(key) != 32:
        raise ValueError(f"{environment_name} must be a base64-encoded 32-byte key")

    return key


def decode_signing_secret(encoded_secret: str) -> bytes:
    return decode_32_byte_key(encoded_secret, "INBOX_PROVISIONER_SIGNING_SECRET")


def decode_transport_encryption_key(encoded_key: str) -> bytes:
    return decode_32_byte_key(encoded_key, "INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY")
