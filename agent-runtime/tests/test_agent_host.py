from __future__ import annotations

import importlib.util
import inspect
import json
import sys
import unittest
from pathlib import Path


HOST_PATH = Path(__file__).resolve().parents[1] / "agent_host.py"
SPEC = importlib.util.spec_from_file_location("omnibrowser_agent_host", HOST_PATH)
assert SPEC is not None and SPEC.loader is not None
agent_host = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = agent_host
SPEC.loader.exec_module(agent_host)


def encoded(value: object) -> bytes:
    return (json.dumps(value) + "\n").encode()


class ProtocolValidationTests(unittest.TestCase):
    def start_message(self) -> dict[str, object]:
        return {
            "type": "start",
            "protocolVersion": 1,
            "runId": "run-1",
            "taskId": "task-1",
            "browserId": "browser-1",
            "agentId": "agent-1",
            "runtimeEpoch": 4,
            "instruction": "Open the fixture and click Continue.",
            "cdpUrl": "ws://127.0.0.1:49152/cdp/random-capability",
            "model": {
                "baseUrl": "https://provider.example/v1",
                "model": "compatible-vision-model",
                "apiKey": "secret-key",
            },
        }

    def test_accepts_start_and_applies_defaults(self) -> None:
        command = agent_host.parse_message(encoded(self.start_message()))
        self.assertIsInstance(command, agent_host.StartCommand)
        self.assertEqual(command.max_steps, 100)
        self.assertEqual(command.runtime_epoch, 4)

    def test_rejects_unknown_fields(self) -> None:
        message = self.start_message()
        message["cdpToken"] = "must-never-be-a-separate-field"
        with self.assertRaisesRegex(agent_host.ProtocolError, "Unknown field"):
            agent_host.parse_message(encoded(message))

    def test_rejects_non_loopback_cdp(self) -> None:
        message = self.start_message()
        message["cdpUrl"] = "wss://remote.example/cdp/token"
        with self.assertRaisesRegex(agent_host.ProtocolError, "loopback"):
            agent_host.parse_message(encoded(message))

    def test_rejects_url_credentials(self) -> None:
        message = self.start_message()
        message["model"] = {
            "baseUrl": "https://user:password@provider.example/v1",
            "model": "model",
            "apiKey": "secret-key",
        }
        with self.assertRaisesRegex(agent_host.ProtocolError, "URL credentials"):
            agent_host.parse_message(encoded(message))

    def test_rejects_oversized_messages_before_json_decode(self) -> None:
        with self.assertRaisesRegex(agent_host.ProtocolError, "limited"):
            agent_host.parse_message(b"{" + b"x" * agent_host.MAX_LINE_BYTES)

    def test_control_command_is_bound_to_a_run(self) -> None:
        command = agent_host.parse_message(
            encoded({"type": "pause", "protocolVersion": 1, "runId": "run-1"})
        )
        self.assertEqual(command, agent_host.ControlCommand(kind="pause", run_id="run-1"))


class RedactionTests(unittest.TestCase):
    def test_scrubs_registered_values_and_url_queries(self) -> None:
        redactor = agent_host.Redactor()
        redactor.add("sk-super-secret", "ws://127.0.0.1/cdp/capability")
        output = redactor.scrub(
            "Bearer sk-super-secret ws://127.0.0.1/cdp/capability "
            "https://provider.example/v1?token=another-secret"
        )
        self.assertNotIn("sk-super-secret", output)
        self.assertNotIn("capability", output)
        self.assertNotIn("another-secret", output)
        self.assertIn("[REDACTED]", output)


class CapabilityPolicyTests(unittest.TestCase):
    def test_disables_cross_card_and_file_capabilities(self) -> None:
        self.assertTrue(
            {
                "close",
                "evaluate",
                "navigate",
                "read_file",
                "replace_file",
                "save_as_pdf",
                "screenshot",
                "switch",
                "upload_file",
                "write_file",
            }.issubset(set(agent_host.DISABLED_ACTIONS))
        )

    def test_guardrail_and_custom_navigation_are_card_scoped(self) -> None:
        host = agent_host.AgentHost.__new__(agent_host.AgentHost)
        command = agent_host.StartCommand(
            run_id="run-1",
            task_id="task-1",
            browser_id="browser-1",
            agent_id="agent-1",
            runtime_epoch=1,
            instruction="Open the account page.",
            cdp_url="ws://127.0.0.1:49152/cdp/capability",
            provider=agent_host.ProviderConfig(
                base_url="https://provider.example/v1",
                model="model",
                api_key="secret",
            ),
            progress_summary=None,
            max_steps=10,
        )
        task = host._effective_task(command)
        self.assertIn("already-connected OmniBrowser card", task)
        self.assertIn("never open/switch/close tabs", task)
        self.assertIn("final answer in the language of the user's request", task)

        source = inspect.getsource(agent_host.AgentHost.start_run)
        self.assertIn("NavigateToUrlEvent(url=url, new_tab=False)", source)


class BrowserSessionOptionsTests(unittest.TestCase):
    def test_profile_keeps_the_card_viewport_and_disables_persistence(self) -> None:
        options = agent_host.browser_profile_options("http://127.0.0.1:9/cdp/capability", Path("/tmp/agent"))
        self.assertEqual(options["cdp_url"], "http://127.0.0.1:9/cdp/capability")
        self.assertIs(options["headless"], False)
        self.assertIs(options["no_viewport"], True)
        self.assertIs(options["is_local"], False)
        self.assertIsNone(options["storage_state"])
        self.assertIsNone(options["user_data_dir"])
        self.assertEqual(options["permissions"], [])

    def test_session_is_built_from_a_profile(self) -> None:
        captured: dict[str, object] = {}

        class Profile:
            def __init__(self, **kwargs: object) -> None:
                captured.update(kwargs)

        class Session:
            def __init__(self, *, browser_profile: Profile) -> None:
                self.cdp_url = captured["cdp_url"]

        runtime = agent_host.SimpleNamespace(BrowserProfile=Profile, BrowserSession=Session)
        host = agent_host.AgentHost.__new__(agent_host.AgentHost)
        host.temp_root = Path("/tmp/agent")
        command = agent_host.parse_message(encoded(ProtocolValidationTests.start_message(ProtocolValidationTests())))
        session = host._browser_session(runtime, command)
        self.assertEqual(session.cdp_url, command.cdp_url)
        self.assertIn("demo_mode", captured)

    def test_missing_final_result_is_left_for_main_to_localize(self) -> None:
        history = agent_host.SimpleNamespace(final_result=lambda: None)
        self.assertEqual(agent_host._history_result(history), "")


class StartFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_missing_browser_use_is_reported_as_an_unavailable_runtime(self) -> None:
        lines: list[str] = []

        class Stream:
            def write(self, text: str) -> None:
                lines.append(text)

            def flush(self) -> None:
                pass

        redactor = agent_host.Redactor()
        host = agent_host.AgentHost(agent_host.ProtocolWriter(Stream(), redactor), redactor, Path("/tmp/agent"))
        command = agent_host.parse_message(encoded(ProtocolValidationTests.start_message(ProtocolValidationTests())))

        def missing_runtime() -> None:
            raise ModuleNotFoundError("No module named 'browser_use'")

        original = agent_host._load_browser_use
        agent_host._load_browser_use = missing_runtime
        try:
            with self.assertRaises(ModuleNotFoundError):
                await host.start_run(command)
        finally:
            agent_host._load_browser_use = original

        message = json.loads(lines[-1])
        self.assertEqual(message["type"], "error")
        self.assertEqual(message["code"], "runtime-unavailable")
        self.assertEqual(message["runId"], "run-1")
        self.assertNotIn("secret-key", "".join(lines))


if __name__ == "__main__":
    unittest.main()
