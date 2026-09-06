import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Protocol

from .app import TenantValidationService
from .contracts import (
    TenantCredentials,
    TenantValidationFailure,
    TenantValidationRequest,
    TenantValidationResult,
    TenantValidationSuccess,
)
from .device_code import (
    AuthenticationChallengeError,
    DeviceCodeCompleter,
    InvalidCredentialsError,
    MicrosoftUnavailableError,
    ZendriverDeviceCodeCompleter,
)
from .powershell import PowerShellAuthenticationError, SubprocessTenantPowerShellProcess
from .session_registry import (
    AuthenticatedTenantSession,
    TenantSessionAuthenticationError,
    TenantSessionRegistry,
)


class DeviceCodePowerShellProcess(Protocol):
    async def authenticate_graph_device_code(
        self, credentials: TenantCredentials, completer: DeviceCodeCompleter
    ) -> None: ...

    async def authenticate_exchange_device_code(
        self, credentials: TenantCredentials, completer: DeviceCodeCompleter
    ) -> None: ...

    async def health_check(self): ...

    async def stop(self) -> None: ...


ProcessFactory = Callable[[], Awaitable[DeviceCodePowerShellProcess]]


class RealTenantValidationService(TenantValidationService):
    def __init__(
        self,
        *,
        headless_browser: bool,
        clock: Callable[[], datetime] | None = None,
        completer: DeviceCodeCompleter | None = None,
        process_factory: ProcessFactory = SubprocessTenantPowerShellProcess.start,
        authentication_timeout_seconds: float = 240,
    ) -> None:
        self._completer = completer or ZendriverDeviceCodeCompleter(headless=headless_browser)
        self._process_factory = process_factory
        self._browser_authentication = asyncio.Semaphore(1)
        self._authentication_timeout_seconds = authentication_timeout_seconds
        self.registry = TenantSessionRegistry(
            clock=clock or (lambda: datetime.now(UTC)), authenticate=self._authenticate
        )

    async def validate(self, request: TenantValidationRequest) -> TenantValidationResult:
        try:
            process = await self.registry.ensure(request.tenantConnectionId, request.credentials)
            health = await process.health_check()
            if health.microsoft_tenant_id is None:
                raise TenantSessionAuthenticationError()
            return TenantValidationSuccess(
                contractVersion="v1", status="success", microsoftTenantId=health.microsoft_tenant_id
            )
        except InvalidCredentialsError:
            return self._failure("invalid_credentials", retryable=False)
        except AuthenticationChallengeError:
            return self._failure("authentication_challenge", retryable=False)
        except (
            MicrosoftUnavailableError,
            PowerShellAuthenticationError,
            TenantSessionAuthenticationError,
        ):
            return self._failure("microsoft_unavailable", retryable=True)
        except Exception:
            return self._failure("microsoft_unavailable", retryable=True)

    async def _authenticate(
        self, connection_id: str, credentials: TenantCredentials
    ) -> AuthenticatedTenantSession:
        process = await self._process_factory()
        session: AuthenticatedTenantSession | None = None
        try:
            async with asyncio.timeout(self._authentication_timeout_seconds):
                async with self._browser_authentication:
                    await process.authenticate_graph_device_code(credentials, self._completer)
                    await process.authenticate_exchange_device_code(credentials, self._completer)
                health = await process.health_check()
                if health.microsoft_tenant_id is None or health.user_principal_name is None:
                    raise TenantSessionAuthenticationError()
                session = AuthenticatedTenantSession(
                    process=process,
                    microsoft_tenant_id=health.microsoft_tenant_id,
                    user_principal_name=health.user_principal_name,
                )
                return session
        finally:
            if session is None:
                await process.stop()

    @staticmethod
    def _failure(code: str, *, retryable: bool) -> TenantValidationFailure:
        return TenantValidationFailure(
            contractVersion="v1", status="failure", code=code, retryable=retryable  # type: ignore[arg-type]
        )
