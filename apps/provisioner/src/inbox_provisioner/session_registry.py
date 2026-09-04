import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from .contracts import TenantCredentials
from .powershell import TenantPowerShellProcess

SESSION_IDLE_TTL = timedelta(minutes=60)


class TenantSessionAuthenticationError(RuntimeError):
    """An authenticated process could not be safely verified for this connection."""


@dataclass(frozen=True)
class AuthenticatedTenantSession:
    process: TenantPowerShellProcess
    microsoft_tenant_id: str
    user_principal_name: str


@dataclass
class _TenantSession:
    process: TenantPowerShellProcess
    microsoft_tenant_id: str
    user_principal_name: str
    last_used_at: datetime


AuthenticateTenantSession = Callable[
    [str, TenantCredentials], Awaitable[AuthenticatedTenantSession]
]


class TenantSessionRegistry:
    def __init__(
        self,
        *,
        clock: Callable[[], datetime],
        authenticate: AuthenticateTenantSession,
    ) -> None:
        self._clock = clock
        self._authenticate = authenticate
        self._sessions: dict[str, _TenantSession] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def ensure(
        self,
        tenant_connection_id: str,
        credentials: TenantCredentials,
    ) -> TenantPowerShellProcess:
        async with self._lock_for(tenant_connection_id):
            session = self._sessions.get(tenant_connection_id)
            if session is not None and not self._is_expired(session):
                if await self._is_healthy(session, credentials):
                    session.last_used_at = self._now()
                    return session.process

            if session is not None:
                await self._dispose_locked(tenant_connection_id)

            candidate = await self._authenticate(tenant_connection_id, credentials)
            if not await self._is_candidate_healthy(candidate, credentials):
                await self._stop(candidate.process)
                raise TenantSessionAuthenticationError(
                    "Authenticated PowerShell session could not be verified"
                )

            self._sessions[tenant_connection_id] = _TenantSession(
                process=candidate.process,
                microsoft_tenant_id=candidate.microsoft_tenant_id,
                user_principal_name=candidate.user_principal_name,
                last_used_at=self._now(),
            )
            return candidate.process

    async def dispose(self, tenant_connection_id: str) -> None:
        async with self._lock_for(tenant_connection_id):
            await self._dispose_locked(tenant_connection_id)

    def _lock_for(self, tenant_connection_id: str) -> asyncio.Lock:
        lock = self._locks.get(tenant_connection_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[tenant_connection_id] = lock
        return lock

    def _is_expired(self, session: _TenantSession) -> bool:
        return self._now() - session.last_used_at >= SESSION_IDLE_TTL

    async def _is_healthy(self, session: _TenantSession, credentials: TenantCredentials) -> bool:
        try:
            health = await session.process.health_check()
        except Exception:
            return False
        expected_email = self._normalized_email(credentials)
        expected_upn = self._normalized_upn(session.user_principal_name)
        actual_upn = self._normalized_upn(health.user_principal_name)
        return (
            health.graph_connected
            and health.exchange_connected
            and health.microsoft_tenant_id == session.microsoft_tenant_id
            and actual_upn == expected_upn
            and expected_upn == expected_email
        )

    async def _is_candidate_healthy(
        self,
        candidate: AuthenticatedTenantSession,
        credentials: TenantCredentials,
    ) -> bool:
        expected_email = self._normalized_email(credentials)
        expected_upn = self._normalized_upn(candidate.user_principal_name)
        if expected_upn != expected_email:
            return False
        try:
            health = await candidate.process.health_check()
        except Exception:
            return False
        return (
            health.graph_connected
            and health.exchange_connected
            and health.microsoft_tenant_id == candidate.microsoft_tenant_id
            and self._normalized_upn(health.user_principal_name) == expected_upn
        )

    async def _dispose_locked(self, tenant_connection_id: str) -> None:
        session = self._sessions.pop(tenant_connection_id, None)
        if session is not None:
            await self._stop(session.process)

    @staticmethod
    async def _stop(process: TenantPowerShellProcess) -> None:
        try:
            await process.stop()
        except Exception:
            pass

    def _now(self) -> datetime:
        return self._clock().astimezone(UTC)

    @staticmethod
    def _normalized_email(credentials: TenantCredentials) -> str:
        return str(credentials.email).casefold()

    @staticmethod
    def _normalized_upn(upn: str | None) -> str | None:
        return upn.casefold() if upn else None
