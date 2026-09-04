FROM ghcr.io/astral-sh/uv:0.11.19 AS uv

FROM python:3.12-slim-bookworm
COPY --from=uv /uv /uvx /bin/

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium curl gnupg \
    && curl -fsSL https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -o /tmp/packages-microsoft-prod.deb \
    && dpkg -i /tmp/packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends powershell \
    && pwsh -NoLogo -NoProfile -NonInteractive -Command "Set-PSRepository -Name PSGallery -InstallationPolicy Trusted; Install-Module Microsoft.Graph -Scope AllUsers -Force -AllowClobber; Install-Module ExchangeOnlineManagement -Scope AllUsers -Force -AllowClobber" \
    && rm -rf /var/lib/apt/lists/* /tmp/packages-microsoft-prod.deb

WORKDIR /app
COPY apps/provisioner/pyproject.toml apps/provisioner/uv.lock ./
COPY apps/provisioner/src ./src
RUN uv sync --locked --no-dev

RUN useradd --create-home --uid 10001 provisioner \
    && chown -R provisioner:provisioner /app
USER provisioner

CMD ["uvicorn", "inbox_provisioner.main:app", "--host", "0.0.0.0", "--port", "8000"]
