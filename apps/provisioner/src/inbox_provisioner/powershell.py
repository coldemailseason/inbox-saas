import asyncio
import json
import os
import re
import signal
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol
from uuid import uuid4

from .contracts import TenantCredentials
from .device_code import DeviceCodeCompleter

INTERNAL_COMMAND_TIMEOUT_SECONDS = 120


@dataclass(frozen=True)
class TenantPowerShellHealthCheck:
    graph_connected: bool
    exchange_connected: bool
    microsoft_tenant_id: str | None
    user_principal_name: str | None


class TenantPowerShellProcess(Protocol):
    async def health_check(self) -> TenantPowerShellHealthCheck: ...

    async def stop(self) -> None: ...


class PowerShellProcessError(RuntimeError):
    """Raised when the internal PowerShell protocol cannot complete."""


class PowerShellAuthenticationError(PowerShellProcessError):
    """A fixed Microsoft device-code command did not authenticate."""


class SubprocessTenantPowerShellProcess:
    """A persistent pwsh process restricted to provisioner-owned commands."""

    _HEALTH_CHECK_COMMAND = """
try {
    $graphOrganization = Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/organization?$select=id'
    $exchangeConnection = Get-ConnectionInformation | Select-Object -First 1
    [pscustomobject]@{
        graphConnected = $null -ne $graphOrganization
        exchangeConnected = $null -ne $exchangeConnection
        microsoftTenantId = [string]$graphOrganization.value[0].id
        userPrincipalName = [string](Get-MgContext).Account
    } | ConvertTo-Json -Compress
} catch {
    [pscustomobject]@{
        graphConnected = $false
        exchangeConnected = $false
        microsoftTenantId = $null
        userPrincipalName = $null
    } | ConvertTo-Json -Compress
}
"""
    _GRAPH_DEVICE_CODE_COMMAND = """
Connect-MgGraph -Scopes @(
    'User.ReadWrite.All',
    'Directory.AccessAsUser.All',
    'Domain.ReadWrite.All',
    'Policy.Read.All',
    'Policy.ReadWrite.ConditionalAccess'
) -UseDeviceAuthentication -NoWelcome -ErrorAction Stop
"""
    _EXCHANGE_DEVICE_CODE_COMMAND = """
Connect-ExchangeOnline -Device -ShowBanner:$false -ErrorAction Stop
"""

    def __init__(self, process: asyncio.subprocess.Process) -> None:
        if process.stdin is None or process.stdout is None:
            raise ValueError("pwsh process must provide stdin and stdout pipes")
        self._process = process
        self._stdin = process.stdin
        self._stdout = process.stdout
        self._command_lock = asyncio.Lock()

    @classmethod
    async def start(cls) -> "SubprocessTenantPowerShellProcess":
        process = await asyncio.create_subprocess_exec(
            "pwsh",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "-",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
        )
        return cls(process)

    async def health_check(self) -> TenantPowerShellHealthCheck:
        output = await self._execute_internal(self._HEALTH_CHECK_COMMAND)
        result = self._parse_health_check(output)
        return TenantPowerShellHealthCheck(
            graph_connected=result.get("graphConnected") is True,
            exchange_connected=result.get("exchangeConnected") is True,
            microsoft_tenant_id=self._optional_string(result.get("microsoftTenantId")),
            user_principal_name=self._optional_string(result.get("userPrincipalName")),
        )

    async def authenticate_graph_device_code(
        self,
        credentials: TenantCredentials,
        completer: DeviceCodeCompleter,
    ) -> None:
        await self._authenticate_with_device_code(
            self._GRAPH_DEVICE_CODE_COMMAND, credentials, completer
        )

    async def authenticate_exchange_device_code(
        self,
        credentials: TenantCredentials,
        completer: DeviceCodeCompleter,
    ) -> None:
        await self._authenticate_with_device_code(
            self._EXCHANGE_DEVICE_CODE_COMMAND, credentials, completer
        )

    async def stop(self) -> None:
        if self._process.returncode is not None:
            return

        # start_new_session makes the pwsh process the group leader, including child commands.
        os.killpg(self._process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(self._process.wait(), timeout=5)
        except TimeoutError:
            os.killpg(self._process.pid, signal.SIGKILL)
            await self._process.wait()

    async def _execute_internal(self, command: str) -> list[str]:
        """Run a provisioner-owned command and collect output up to its unique marker."""
        if self._process.returncode is not None:
            raise PowerShellProcessError("PowerShell process is not running")

        marker = f"__INBOX_POWERSHELL_COMPLETE_{uuid4().hex}__"
        framed_command = f"& {{\n{command}\n}}\n[Console]::Out.WriteLine('{marker}')\n"
        async with self._command_lock:
            self._stdin.write(framed_command.encode())
            await self._stdin.drain()
            output: list[str] = []
            try:
                async with asyncio.timeout(INTERNAL_COMMAND_TIMEOUT_SECONDS):
                    while True:
                        line = await self._stdout.readline()
                        if not line:
                            raise PowerShellProcessError(
                                "PowerShell process ended before command completion"
                            )
                        text = line.decode(errors="replace").rstrip("\r\n")
                        if text == marker:
                            return output
                        output.append(text)
            except TimeoutError as error:
                raise PowerShellProcessError("PowerShell command timed out") from error

    async def _authenticate_with_device_code(
        self,
        command: str,
        credentials: TenantCredentials,
        completer: DeviceCodeCompleter,
    ) -> None:
        if self._process.returncode is not None:
            raise PowerShellProcessError("PowerShell process is not running")

        complete_marker = f"__INBOX_POWERSHELL_COMPLETE_{uuid4().hex}__"
        success_marker = f"__INBOX_POWERSHELL_SUCCESS_{uuid4().hex}__"
        failure_marker = f"__INBOX_POWERSHELL_FAILURE_{uuid4().hex}__"
        framed_command = (
            "& {\n"
            "try {\n"
            f"{command}\n"
            f"[Console]::Out.WriteLine('{success_marker}')\n"
            "} catch {\n"
            f"[Console]::Out.WriteLine('{failure_marker}')\n"
            "}\n"
            "}\n"
            f"[Console]::Out.WriteLine('{complete_marker}')\n"
        )
        async with self._command_lock:
            self._stdin.write(framed_command.encode())
            await self._stdin.drain()
            device_code_seen = False
            succeeded = False
            try:
                async with asyncio.timeout(INTERNAL_COMMAND_TIMEOUT_SECONDS):
                    while True:
                        line = await self._stdout.readline()
                        if not line:
                            raise PowerShellProcessError(
                                "PowerShell process ended before command completion"
                            )
                        text = line.decode(errors="replace").rstrip("\r\n")
                        if text == complete_marker:
                            if not device_code_seen or not succeeded:
                                raise PowerShellAuthenticationError(
                                    "Microsoft authentication did not complete"
                                )
                            return
                        if text == success_marker:
                            succeeded = True
                            continue
                        if text == failure_marker:
                            continue
                        if not device_code_seen:
                            device_code = self._device_code_from(text)
                            if device_code is not None:
                                device_code_seen = True
                                await completer.complete(device_code, credentials)
            except TimeoutError as error:
                raise PowerShellProcessError("PowerShell command timed out") from error

    @staticmethod
    def _device_code_from(output: str) -> str | None:
        match = re.search(
            r"\b(?:device )?code\s*(?:is|:)?\s*['\"]?([A-Z0-9]{8,}(?:-[A-Z0-9]{4,})*)",
            output,
        )
        return match.group(1) if match else None

    @staticmethod
    def _parse_health_check(output: list[str]) -> Mapping[str, object]:
        for line in reversed(output):
            try:
                decoded = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(decoded, dict):
                return decoded
        raise PowerShellProcessError("PowerShell health check returned no result")

    @staticmethod
    def _optional_string(value: object) -> str | None:
        return value if isinstance(value, str) and value else None
