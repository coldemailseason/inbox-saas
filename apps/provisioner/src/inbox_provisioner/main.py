import os

from .app import create_app
from .runtime_config import decode_signing_secret, decode_transport_encryption_key

signing_secret = decode_signing_secret(os.environ["INBOX_PROVISIONER_SIGNING_SECRET"])
transport_encryption_key = decode_transport_encryption_key(
    os.environ["INBOX_PROVISIONER_TRANSPORT_ENCRYPTION_KEY"]
)
headless_browser = os.environ.get("INBOX_PROVISIONER_HEADLESS_BROWSER", "true").casefold() == "true"
app = create_app(
    signing_secret=signing_secret,
    transport_encryption_key=transport_encryption_key,
    headless_browser=headless_browser,
)
