import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from inbox_provisioner.contracts import TenantCredentials
from inbox_provisioner.powershell import PowerShellProcessError, TenantPowerShellHealthCheck
from inbox_provisioner.session_registry import (
    AuthenticatedTenantSession,
    TenantSessionAuthenticationError,
    TenantSessionRegistry,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = datetime(2026, 1, 1, tzinfo=UTC)

    def advance(self, duration: timedelta) -> None:
        self.now += duration


class FakeProcess:
    def __init__(self, health: TenantPowerShellHealthCheck) -> None:
        self.health = health
        self.stopped = False
        self.health_error: Exception | None = None

    async def health_check(self) -> TenantPowerShellHealthCheck:
        if self.health_error is not None:
            raise self.health_error
        return self.health

    async def stop(self) -> None:
        self.stopped = True


class FakeFactory:
    def __init__(self, candidates: list[AuthenticatedTenantSession]) -> None:
        self.candidates = candidates
        self.calls: list[str] = []

    async def __call__(
        self,
        tenant_connection_id: str,
        credentials: TenantCredentials,
    ) -> AuthenticatedTenantSession:
        self.calls.append(tenant_connection_id)
        await asyncio.sleep(0)
        return self.candidates.pop(0)


def credentials(email: str = "Admin@Example.com") -> TenantCredentials:
    return TenantCredentials(email=email, password="private-password")


def candidate(
    *,
    tenant_id: str = "tenant-1",
    upn: str = "admin@example.com",
    health_tenant_id: str | None = None,
    health_upn: str | None = None,
    graph_connected: bool = True,
    exchange_connected: bool = True,
) -> AuthenticatedTenantSession:
    process = FakeProcess(
        TenantPowerShellHealthCheck(
            graph_connected=graph_connected,
            exchange_connected=exchange_connected,
            microsoft_tenant_id=health_tenant_id or tenant_id,
            user_principal_name=health_upn or upn,
        )
    )
    return AuthenticatedTenantSession(process, tenant_id, upn)


def registry_for(
    candidates: list[AuthenticatedTenantSession],
) -> tuple[TenantSessionRegistry, FakeClock, FakeFactory]:
    clock = FakeClock()
    factory = FakeFactory(candidates)
    return TenantSessionRegistry(clock=lambda: clock.now, authenticate=factory), clock, factory


def test_distinct_connections_never_share_sessions() -> None:
    async def scenario() -> None:
        first, second = candidate(), candidate(tenant_id="tenant-2")
        registry, _, factory = registry_for([first, second])

        first_process = await registry.ensure("connection-1", credentials())
        second_process = await registry.ensure("connection-2", credentials())

        assert first_process is first.process
        assert second_process is second.process
        assert factory.calls == ["connection-1", "connection-2"]

    asyncio.run(scenario())


def test_healthy_session_is_reused_and_touched() -> None:
    async def scenario() -> None:
        first = candidate()
        registry, clock, factory = registry_for([first])

        assert await registry.ensure("connection-1", credentials()) is first.process
        clock.advance(timedelta(minutes=59))
        assert await registry.ensure("connection-1", credentials()) is first.process
        clock.advance(timedelta(minutes=59))
        assert await registry.ensure("connection-1", credentials()) is first.process

        assert factory.calls == ["connection-1"]

    asyncio.run(scenario())


def test_session_is_replaced_after_sixty_minutes_idle() -> None:
    async def scenario() -> None:
        first, replacement = candidate(), candidate()
        registry, clock, factory = registry_for([first, replacement])

        await registry.ensure("connection-1", credentials())
        clock.advance(timedelta(minutes=60))
        assert await registry.ensure("connection-1", credentials()) is replacement.process

        assert first.process.stopped
        assert factory.calls == ["connection-1", "connection-1"]

    asyncio.run(scenario())


def test_unhealthy_session_is_replaced() -> None:
    async def scenario() -> None:
        first, replacement = candidate(), candidate()
        registry, _, factory = registry_for([first, replacement])

        await registry.ensure("connection-1", credentials())
        first.process.health = TenantPowerShellHealthCheck(
            False,
            True,
            "tenant-1",
            "admin@example.com",
        )
        assert await registry.ensure("connection-1", credentials()) is replacement.process

        assert first.process.stopped
        assert factory.calls == ["connection-1", "connection-1"]

    asyncio.run(scenario())


def test_protocol_failure_disposes_the_retained_session_and_replaces_it() -> None:
    async def scenario() -> None:
        first, replacement = candidate(), candidate()
        registry, _, factory = registry_for([first, replacement])

        await registry.ensure("connection-1", credentials())
        first.process.health_error = PowerShellProcessError("PowerShell command timed out")

        assert await registry.ensure("connection-1", credentials()) is replacement.process
        assert first.process.stopped
        assert factory.calls == ["connection-1", "connection-1"]

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("health_tenant_id", "health_upn"),
    [("other-tenant", None), (None, "other@example.com")],
)
def test_retained_session_with_mismatched_identity_is_replaced(
    health_tenant_id: str | None,
    health_upn: str | None,
) -> None:
    async def scenario() -> None:
        first, replacement = candidate(), candidate()
        registry, _, factory = registry_for([first, replacement])

        await registry.ensure("connection-1", credentials())
        first.process.health = TenantPowerShellHealthCheck(
            True,
            True,
            health_tenant_id or "tenant-1",
            health_upn or "admin@example.com",
        )
        assert await registry.ensure("connection-1", credentials()) is replacement.process

        assert first.process.stopped
        assert factory.calls == ["connection-1", "connection-1"]

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("health_tenant_id", "health_upn"),
    [("other-tenant", None), (None, "other@example.com")],
)
def test_mismatched_candidate_identity_is_stopped(
    health_tenant_id: str | None,
    health_upn: str | None,
) -> None:
    async def scenario() -> None:
        invalid = candidate(health_tenant_id=health_tenant_id, health_upn=health_upn)
        valid = candidate()
        registry, _, factory = registry_for([invalid, valid])

        with pytest.raises(TenantSessionAuthenticationError):
            await registry.ensure("connection-1", credentials())
        assert invalid.process.stopped

        assert await registry.ensure("connection-1", credentials()) is valid.process
        assert factory.calls == ["connection-1", "connection-1"]

    asyncio.run(scenario())


def test_dispose_stops_and_removes_session() -> None:
    async def scenario() -> None:
        first, replacement = candidate(), candidate()
        registry, _, factory = registry_for([first, replacement])

        await registry.ensure("connection-1", credentials())
        await registry.dispose("connection-1")
        assert first.process.stopped
        assert await registry.ensure("connection-1", credentials()) is replacement.process
        assert factory.calls == ["connection-1", "connection-1"]

    asyncio.run(scenario())


def test_concurrent_ensure_for_one_connection_authenticates_once() -> None:
    async def scenario() -> None:
        first = candidate()
        registry, _, factory = registry_for([first])

        processes = await asyncio.gather(
            registry.ensure("connection-1", credentials()),
            registry.ensure("connection-1", credentials()),
        )

        assert processes == [first.process, first.process]
        assert factory.calls == ["connection-1"]

    asyncio.run(scenario())
