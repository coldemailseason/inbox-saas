import asyncio
import sys
from types import SimpleNamespace

import pytest

from inbox_provisioner.contracts import TenantCredentials, TenantValidationRequest
from inbox_provisioner.device_code import (
    AuthenticationChallengeError,
    InvalidCredentialsError,
    MicrosoftUnavailableError,
    ZendriverDeviceCodeCompleter,
)
from inbox_provisioner.powershell import (
    PowerShellProcessError,
    SubprocessTenantPowerShellProcess,
    TenantPowerShellHealthCheck,
)
from inbox_provisioner.tenant_validation import RealTenantValidationService


def request(connection_id: str = "connection-1") -> TenantValidationRequest:
    return TenantValidationRequest(
        contractVersion="v1",
        jobId="job-1",
        tenantConnectionId=connection_id,
        credentials=TenantCredentials(email="Admin@Example.com", password="private-password"),
    )


class FakeCompleter:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.active = 0
        self.maximum_active = 0
        self.codes: list[str] = []

    async def complete(self, code: str, credentials: TenantCredentials) -> None:
        self.active += 1
        self.maximum_active = max(self.maximum_active, self.active)
        self.codes.append(code)
        await asyncio.sleep(0)
        self.active -= 1
        if self.error is not None:
            raise self.error


class FakeProcess:
    def __init__(
        self,
        *,
        tenant_id: str = "tenant-1",
        upn: str = "admin@example.com",
        health_results: list[TenantPowerShellHealthCheck] | None = None,
    ) -> None:
        self.health = TenantPowerShellHealthCheck(True, True, tenant_id, upn)
        self.health_results = health_results or []
        self.commands: list[str] = []
        self.stopped = False

    async def authenticate_graph_device_code(
        self, credentials: TenantCredentials, completer: FakeCompleter
    ) -> None:
        self.commands.append("graph")
        await completer.complete("AAAA-BBBB", credentials)

    async def authenticate_exchange_device_code(
        self, credentials: TenantCredentials, completer: FakeCompleter
    ) -> None:
        self.commands.append("exchange")
        await completer.complete("CCCC-DDDD", credentials)

    async def health_check(self) -> TenantPowerShellHealthCheck:
        if self.health_results:
            return self.health_results.pop(0)
        return self.health

    async def stop(self) -> None:
        self.stopped = True


class FakeFactory:
    def __init__(self, processes: list[FakeProcess]) -> None:
        self.processes = processes
        self.calls = 0

    async def __call__(self) -> FakeProcess:
        self.calls += 1
        return self.processes.pop(0)


class HangingStdout:
    async def readline(self) -> bytes:
        await asyncio.Event().wait()


class FakeStdin:
    def write(self, data: bytes) -> None:
        pass

    async def drain(self) -> None:
        pass


class HangingSubprocess:
    returncode = None
    stdin = FakeStdin()
    stdout = HangingStdout()


def test_success_retains_and_reuses_verified_session() -> None:
    async def scenario() -> None:
        process = FakeProcess()
        factory = FakeFactory([process])
        service = RealTenantValidationService(
            headless_browser=True, completer=FakeCompleter(), process_factory=factory
        )

        first = await service.validate(request())
        second = await service.validate(request())

        assert first.status == "success"
        assert first.microsoftTenantId == "tenant-1"
        assert second.status == "success"
        assert factory.calls == 1
        assert process.commands == ["graph", "exchange"]
        assert not process.stopped

    asyncio.run(scenario())


def test_powershell_uses_only_the_fixed_graph_and_exchange_commands() -> None:
    graph_command = SubprocessTenantPowerShellProcess._GRAPH_DEVICE_CODE_COMMAND
    assert "User.ReadWrite.All" in graph_command
    assert "Directory.AccessAsUser.All" in graph_command
    assert "Domain.ReadWrite.All" in graph_command
    assert "Policy.Read.All" in graph_command
    assert "Policy.ReadWrite.ConditionalAccess" in graph_command
    assert "Connect-ExchangeOnline -Device -ShowBanner:$false" in (
        SubprocessTenantPowerShellProcess._EXCHANGE_DEVICE_CODE_COMMAND
    )
    assert (
        SubprocessTenantPowerShellProcess._device_code_from(
            "Open microsoft.com/devicelogin and enter code ABCD1234."
        )
        == "ABCD1234"
    )


def test_powershell_health_check_times_out_when_completion_marker_is_missing(monkeypatch) -> None:
    import inbox_provisioner.powershell as powershell

    monkeypatch.setattr(powershell, "INTERNAL_COMMAND_TIMEOUT_SECONDS", 0.01)

    async def scenario() -> None:
        process = SubprocessTenantPowerShellProcess(HangingSubprocess())  # type: ignore[arg-type]
        with pytest.raises(PowerShellProcessError, match="timed out"):
            await asyncio.wait_for(process.health_check(), timeout=0.1)

    asyncio.run(scenario())


def test_device_code_command_times_out_when_completion_marker_is_missing(monkeypatch) -> None:
    import inbox_provisioner.powershell as powershell

    monkeypatch.setattr(powershell, "INTERNAL_COMMAND_TIMEOUT_SECONDS", 0.01)

    async def scenario() -> None:
        process = SubprocessTenantPowerShellProcess(HangingSubprocess())  # type: ignore[arg-type]
        with pytest.raises(PowerShellProcessError, match="timed out"):
            await asyncio.wait_for(
                process.authenticate_graph_device_code(request().credentials, FakeCompleter()),
                timeout=0.1,
            )

    asyncio.run(scenario())


def test_browser_authentication_is_serialized_across_connections() -> None:
    async def scenario() -> None:
        completer = FakeCompleter()
        service = RealTenantValidationService(
            headless_browser=True,
            completer=completer,
            process_factory=FakeFactory([FakeProcess(), FakeProcess()]),
        )

        results = await asyncio.gather(
            service.validate(request("one")), service.validate(request("two"))
        )

        assert [result.status for result in results] == ["success", "success"]
        assert completer.maximum_active == 1

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "mismatched_health",
    [
        TenantPowerShellHealthCheck(True, True, "other-tenant", "admin@example.com"),
        TenantPowerShellHealthCheck(True, True, "tenant-1", "other@example.com"),
    ],
)
def test_wrong_tenant_or_upn_is_cleaned_up_without_secret_exposure(
    mismatched_health: TenantPowerShellHealthCheck,
) -> None:
    async def scenario() -> None:
        process = FakeProcess(health_results=[FakeProcess().health, mismatched_health])
        service = RealTenantValidationService(
            headless_browser=True, completer=FakeCompleter(), process_factory=FakeFactory([process])
        )

        result = await service.validate(request())

        assert result.model_dump() == {
            "contractVersion": "v1",
            "status": "failure",
            "code": "microsoft_unavailable",
            "retryable": True,
        }
        assert "private-password" not in result.model_dump_json()
        assert "AAAA-BBBB" not in result.model_dump_json()
        assert process.stopped

    asyncio.run(scenario())


def test_safe_failure_classification() -> None:
    async def scenario(error: Exception, expected_code: str, retryable: bool) -> None:
        service = RealTenantValidationService(
            headless_browser=True,
            completer=FakeCompleter(error),
            process_factory=FakeFactory([FakeProcess()]),
        )

        result = await service.validate(request())

        assert result.status == "failure"
        assert result.code == expected_code
        assert result.retryable is retryable
        assert "private-password" not in result.model_dump_json()

    asyncio.run(scenario(InvalidCredentialsError(), "invalid_credentials", False))
    asyncio.run(scenario(AuthenticationChallengeError(), "authentication_challenge", False))
    asyncio.run(scenario(MicrosoftUnavailableError(), "microsoft_unavailable", True))


def test_zendriver_browser_is_always_stopped(monkeypatch) -> None:
    class Browser:
        stopped = False

        async def get(self, url: str):
            raise RuntimeError("browser unavailable")

        async def stop(self) -> None:
            self.stopped = True

    browser = Browser()

    async def start(*, headless: bool) -> Browser:
        assert headless
        return browser

    monkeypatch.setitem(sys.modules, "zendriver", SimpleNamespace(start=start))

    async def scenario() -> None:
        completer = ZendriverDeviceCodeCompleter(headless=True)
        try:
            await completer.complete("AAAA-BBBB", request().credentials)
        except MicrosoftUnavailableError:
            pass
        else:
            raise AssertionError("expected unavailable result")
        assert browser.stopped

    asyncio.run(scenario())
