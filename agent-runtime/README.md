# Browser Use sidecar

`agent_host.py` is the only Python entry point used by OmniBrowser. It is a
single-run JSONL worker: main sends `start`, then optional `pause`, `resume`, or
`stop` commands; the worker emits `ready`, `state`, `action`, `result`, and
`error` messages. `protocolVersion` is currently `1`. The capability-bearing
CDP URL and provider key travel only over stdin and are redacted from stderr.

The pinned production set is built with CPython 3.12 and PyInstaller `onedir`.
Build each architecture on a native macOS runner; PyInstaller does not produce
the other macOS architecture by cross-compiling:

```sh
npm run agent:build            # native architecture, Python 3.12 from PATH
OMNIBROWSER_AGENT_PYTHON=/path/to/python3.12 npm run agent:build
```

`build.sh` creates `agent-runtime/.venv-<arch>`, installs `requirements.lock`
with hash checking and writes `agent-runtime/dist/<arch>/agent-host/agent-host`.
`OMNIBROWSER_AGENT_VENV`, `OMNIBROWSER_AGENT_DIST_DIR` and
`OMNIBROWSER_AGENT_WORK_DIR` move the virtual environment and the outputs, for
example out of a synced folder. When packaging, Forge copies the complete
`agent-host` directory built for the architecture being packaged outside
`app.asar`, to `OmniBrowser.app/Contents/Resources/agent-host`
(`OMNIBROWSER_AGENT_RESOURCE_PATH` points it at another build). A release build
signs its Mach-O files before re-signing the app and verifies both signatures.
The installed application therefore never invokes or depends on system Python.
`npm run package` fails with an explanation when the sidecar was not built.

`npm run agent:self-check` checks imports and the exact Browser Use/CDP Use
versions without an API key or browser. `build.sh` runs the same check against
the frozen executable. `npm run agent:test` runs the protocol unit tests, which
need no dependencies.

`npm run agent:compat` is the scoped-CDP compatibility trace. It needs a Python
with `requirements.lock` installed (`OMNIBROWSER_AGENT_PYTHON`, for example
`agent-runtime/.venv-arm64/bin/python`). Without a model or network access,
`compat_trace.py` drives a card through the production `ScopedCdpGateway` with
Browser Use and checks: only the card's own target is listed; DOM extraction;
screenshots while the card is visible and while it is hidden (no visibility
change reaches the page); click, typing and navigation, with URL and title
updates; and denial of new tabs, a neighbouring card, `file:` navigation,
cookies and closing the page. Agent clicks must never count as the user
selecting the card. Cross-origin OOPIF targets remain deliberately hidden so a
worker cannot broaden its capability beyond the assigned `WebContents`.

The E2E test `an agent completes a task in its own card…` runs the frozen
sidecar against a local OpenAI-compatible fake model; it is skipped when the
sidecar was not built, and CI requires it. To update Browser Use:

1. update `requirements.in`, regenerate `requirements.lock` for Python 3.12,
   and review the dependency diff;
2. run `npm run agent:compat` and the agent E2E test;
3. update the gateway allowlist only from that reviewed trace;
4. build and self-check native `arm64` and `x64` sidecars;
5. complete the signing/notarization checks in `docs/release-checklist.md`.

`npm run package:test` deliberately uses `test-stub/` so the Electron E2E suite
does not need the sidecar to package. That package is not a release artifact,
cannot execute agents, and `npm run make` never uses it. It is written to
`out/test-stub/` (unless `OMNIBROWSER_OUT_DIR` is set), so it never replaces the
real application that `npm run package` writes to `out/`.

An unpackaged run (`npm start`) looks for the sidecar in this order:
`OMNIBROWSER_AGENT_HOST_PATH`, the frozen `dist/<arch>/agent-host`, and
`agent_host.py` on `OMNIBROWSER_AGENT_PYTHON` or on the `.venv-<arch>` Python
that `build.sh` creates. It never falls back to the system Python, which has no
Browser Use: without a build, the agent chat asks for `npm run agent:build`.
