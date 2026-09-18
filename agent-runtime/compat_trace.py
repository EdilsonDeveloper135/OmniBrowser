#!/usr/bin/env python3
"""Scoped-CDP compatibility trace for the pinned Browser Use release.

Run by ``npm run agent:compat`` (pocs/agent-gateway-main.cjs) with the Python environment that has
requirements.lock installed. It needs no model and no network: Browser Use drives one OmniBrowser card through the
ScopedCdpGateway exactly as the sidecar does, and every check is reported as JSON on stdout.

stdin/stdout is a small JSONL protocol with the Electron harness: one ``config`` line in, ``phase`` requests out
(answered by one ``ack`` line each), and a final ``result`` line out.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

import agent_host


def _write(message: dict[str, Any]) -> None:
    sys.__stdout__.write(json.dumps(message) + "\n")
    sys.__stdout__.flush()


def _read() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("The harness closed the protocol.")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise RuntimeError("Invalid harness message.")
    return value


async def _phase(name: str) -> dict[str, Any]:
    _write({"type": "phase", "phase": name})
    return await asyncio.to_thread(_read)


async def _until(read: Callable[[], Awaitable[Any]], expected: Any, timeout: float = 5.0) -> Any:
    deadline = time.monotonic() + timeout
    value = await read()
    while value != expected and time.monotonic() < deadline:
        await asyncio.sleep(0.1)
        value = await read()
    return value


async def _denied(send: Callable[[], Awaitable[Any]]) -> bool:
    try:
        await send()
    except Exception:
        return True
    return False


def _find(selector_map: dict[int, Any], tag: str) -> Any:
    for node in selector_map.values():
        if getattr(node, "tag_name", "").lower() == tag:
            return node
    raise RuntimeError(f"No interactive <{tag}> element was extracted.")


async def trace(config: dict[str, Any]) -> dict[str, Any]:
    runtime = agent_host._load_browser_use()
    from browser_use.browser.events import ClickElementEvent, NavigateToUrlEvent, TypeTextEvent  # type: ignore[import-not-found]

    checks: dict[str, Any] = {"browserUse": runtime.browser_use_version, "cdpUse": runtime.cdp_use_version}
    temp_root = Path(tempfile.mkdtemp(prefix="omnibrowser-compat-"))
    profile = runtime.BrowserProfile(**agent_host.browser_profile_options(config["cdpUrl"], temp_root))
    session = runtime.BrowserSession(browser_profile=profile)
    await session.start()
    try:
        targets = session.session_manager.get_all_page_targets()
        checks["onlyOwnTarget"] = [target.target_id for target in targets] == [config["ownTargetId"]]

        visible = await session.get_browser_state_summary(include_screenshot=True)
        checks["visibleScreenshot"] = bool(visible.screenshot)
        checks["initialUrl"] = visible.url == config["pageUrl"]
        selector_map = visible.dom_state.selector_map
        checks["interactiveElements"] = len(selector_map)
        button = _find(selector_map, "button")
        field = _find(selector_map, "input")

        await _phase("hide")
        started = time.monotonic()
        hidden = await session.get_browser_state_summary(include_screenshot=True)
        checks["hiddenScreenshot"] = bool(hidden.screenshot)
        checks["hiddenStateSeconds"] = round(time.monotonic() - started, 2)
        await _phase("hidden-captured")

        click = session.event_bus.dispatch(ClickElementEvent(node=button))
        await click
        await click.event_result(raise_if_any=True, raise_if_none=False)
        checks["clickUpdatesTitle"] = await _until(session.get_current_page_title, "Clicked") == "Clicked"

        typing = session.event_bus.dispatch(TypeTextEvent(node=field, text="hola agente"))
        await typing
        await typing.event_result(raise_if_any=True, raise_if_none=False)
        cdp_session = await session.get_or_create_cdp_session()

        async def field_value() -> Any:
            result = await cdp_session.cdp_client.send.Runtime.evaluate(
                params={"expression": "document.querySelector('input').value", "returnByValue": True},
                session_id=cdp_session.session_id,
            )
            return result.get("result", {}).get("value")

        checks["typedText"] = await _until(field_value, "hola agente") == "hola agente"

        navigation = session.event_bus.dispatch(NavigateToUrlEvent(url=config["nextUrl"], new_tab=False))
        await navigation
        await navigation.event_result(raise_if_any=True, raise_if_none=False)
        checks["navigationUpdatesUrl"] = await _until(session.get_current_page_url, config["nextUrl"]) == config["nextUrl"]

        root = session.cdp_client
        page_session = cdp_session.session_id
        checks["deniesNewTab"] = await _denied(lambda: root.send.Target.createTarget(params={"url": "about:blank"}))
        checks["deniesForeignTarget"] = await _denied(
            lambda: root.send.Target.attachToTarget(params={"targetId": config["foreignTargetId"], "flatten": True})
        )
        checks["deniesLocalFile"] = await _denied(
            lambda: root.send.Page.navigate(params={"url": "file:///etc/hosts"}, session_id=page_session)
        )
        checks["deniesCookieExport"] = await _denied(lambda: root.send.Network.getAllCookies(session_id=page_session))
        checks["deniesStorageCookies"] = await _denied(lambda: root.send.Storage.getCookies())
        checks["deniesPageClose"] = await _denied(lambda: root.send.Page.close(session_id=page_session))
        checks["urlAfterDenials"] = await session.get_current_page_url() == config["nextUrl"]
    finally:
        await session.stop()
    return checks


def main() -> int:
    # Browser Use prints to stdout; the protocol keeps the real stream and everything else goes to stderr.
    sys.stdout = sys.stderr
    try:
        config = _read()
        checks = asyncio.run(trace(config))
        _write({"type": "result", "checks": checks})
        return 0
    except Exception as error:  # the harness reports the failure with its own context
        _write({"type": "result", "error": f"{type(error).__name__}: {error}"})
        return 1


if __name__ == "__main__":
    agent_host._configure_environment(Path(tempfile.mkdtemp(prefix="omnibrowser-compat-config-")))
    raise SystemExit(main())
