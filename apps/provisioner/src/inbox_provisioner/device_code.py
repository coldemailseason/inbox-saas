import asyncio
from typing import Protocol

from .contracts import TenantCredentials


class DeviceCodeCompletionError(RuntimeError):
    """Device-code sign-in could not be completed safely."""


class InvalidCredentialsError(DeviceCodeCompletionError):
    pass


class AuthenticationChallengeError(DeviceCodeCompletionError):
    pass


class MicrosoftUnavailableError(DeviceCodeCompletionError):
    pass


class DeviceCodeCompleter(Protocol):
    async def complete(self, device_code: str, credentials: TenantCredentials) -> None: ...


class ZendriverDeviceCodeCompleter:
    def __init__(self, *, headless: bool, timeout_seconds: float = 90) -> None:
        self._headless = headless
        self._timeout_seconds = timeout_seconds

    async def complete(self, device_code: str, credentials: TenantCredentials) -> None:
        import zendriver as zd

        browser = None
        try:
            async with asyncio.timeout(self._timeout_seconds):
                browser = await zd.start(headless=self._headless)
                page = await browser.get("https://microsoft.com/devicelogin")
                await (await page.select("input[name='otc']", timeout=15)).send_keys(device_code)
                await self._click_primary(page)
                await (await page.select("input[type='email']", timeout=15)).send_keys(
                    str(credentials.email)
                )
                await self._click_primary(page)
                await (await page.select("input[type='password']", timeout=15)).send_keys(
                    credentials.password
                )
                await self._click_primary(page)
                await self._finish_expected_flow(page)
        except TimeoutError as error:
            raise MicrosoftUnavailableError() from error
        except (InvalidCredentialsError, AuthenticationChallengeError, MicrosoftUnavailableError):
            raise
        except Exception as error:
            raise MicrosoftUnavailableError() from error
        finally:
            if browser is not None:
                try:
                    await browser.stop()
                except Exception:
                    pass

    async def _finish_expected_flow(self, page: object) -> None:
        # Only routine consent/continue screens are automated; other prompts require human action.
        for _ in range(3):
            await page.wait(1)  # type: ignore[attr-defined]
            content = (await page.get_content()).casefold()  # type: ignore[attr-defined]
            if "your account or password is incorrect" in content:
                raise InvalidCredentialsError()
            if any(
                prompt in content
                for prompt in (
                    "approve sign in request",
                    "more information required",
                    "enter code",
                    "security defaults",
                    "captcha",
                    "unusual activity",
                )
            ):
                raise AuthenticationChallengeError()
            if "you have signed in" in content or "you can close this window" in content:
                return
            if "stay signed in" in content or "permissions requested" in content:
                await self._click_primary(page)
                continue
            raise AuthenticationChallengeError()
        raise AuthenticationChallengeError()

    @staticmethod
    async def _click_primary(page: object) -> None:
        await (await page.select("#idSIButton9", timeout=15)).click()  # type: ignore[attr-defined]
