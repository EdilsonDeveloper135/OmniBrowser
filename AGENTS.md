# AGENTS.md — mapa de áreas para trabajo en paralelo

Este documento existe para que varios agentes o worktrees puedan trabajar a la vez sin pisarse. Describe la
arquitectura tal como es hoy — no la define ni la sustituye. Para el diseño completo, lea
[`docs/architecture.md`](docs/architecture.md) (tabla de responsabilidades por módulo) y
[`CONTRIBUTING.md`](CONTRIBUTING.md) (convenciones y pruebas exigidas por tipo de cambio).

Este es un único paquete npm (no hay workspaces): todas las áreas comparten `package.json`, `package-lock.json` y
`tsconfig.json`. La separación de abajo es por directorio y por contrato, no por paquete independiente.

## Áreas

### `src/main` — proceso principal Electron
- **Responsabilidad:** ciclo de vida de la app, IPC (`ipc/`), persistencia (`persistence/`), modelo de dominio
  (`domain/`), sesiones y particiones por perfil (`profiles/`), runtime de `WebContentsView` (`browser/`), política de
  seguridad (`security/`), scheduler de guardado (`lifecycle/`), y los agentes Browser Use por tarjeta (`agents/`).
- **Depende de:** `src/shared` (contratos, esquemas Zod, tipos, constantes). Lanza `agent-runtime` como subproceso
  (`agent-worker.ts`) y le habla por stdin/stdout JSONL.
- **No debe:** importar nada de `src/renderer`; aceptar entrada IPC sin validar con Zod; exponer `WebContents` o
  capacidades CDP fuera de `ScopedCdpGateway`.
- **Pruebas al tocar esta área:** `npm run verify`; si toca `agents/`, además `npm run agent:test`,
  `npm run agent:build` y `npm run agent:compat` (ver [CONTRIBUTING.md](CONTRIBUTING.md)).

### `src/preload`
- **Responsabilidad:** puente mínimo e inmutable (`window.omniBrowser`) entre el shell confiable y `src/main`.
- **Depende de:** `src/shared` (tipos del contrato IPC).
- **No debe:** exponer `ipcRenderer` genérico, objetos Electron o Node al renderer.
- Es un archivo único y de bajo cambio: normalmente se toca junto con `src/main/ipc` o `src/renderer`, no de forma aislada.

### `src/renderer` — shell React
- **Responsabilidad:** UI del canvas, tarjetas, árbol organizador, minimapa, panel de chat de agentes
  (`components/`), y helpers de estado/derivación puros (`lib/`).
- **Depende de:** `src/shared` y la API expuesta por `src/preload` únicamente.
- **No debe:** acceder a Node, Electron o Chromium directamente; usar `window.prompt()` síncrono (use `PromptModal`);
  dejar un árbol crítico sin `ErrorBoundary`.
- **Pruebas al tocar esta área:** `npm run verify` (Vitest + Testing Library en `tests/unit/components`).

### `src/shared` — contrato entre main y renderer
- **Responsabilidad:** `contracts.ts` y `schemas.ts` (esquemas Zod del IPC), `geometry.ts`, `z-order.ts`, `urls.ts`,
  `errors.ts`, `constants.ts`.
- **Es la superficie más sensible del repo:** la usan `main` y `renderer` por igual (34 y 31 llamadas respectivamente
  según el grafo de dependencias). Un cambio aquí obliga a revisar ambos lados y sus pruebas en la misma tarea; no lo
  trate como un área independiente para un agente separado.
- Cambiar un esquema o contrato es responsabilidad de quien añade la funcionalidad en `main`/`renderer`, hecho en el
  mismo cambio — no como una tarea de "actualizar shared" aparte.

### `agent-runtime` — sidecar Python (Browser Use)
- **Responsabilidad:** `agent_host.py` (protocolo del sidecar), `compat_trace.py`, empaquetado congelado
  (`build.sh`, `agent_host.spec`), dependencias fijadas (`requirements.lock`) y sus propias pruebas
  (`agent-runtime/tests/`).
- **Depende de:** su propio entorno Python 3.12 + `requirements.lock`. Habla con `src/main/agents/agent-worker.ts`
  por un protocolo JSONL — ese protocolo (no el código Python interno) es la superficie compartida con `src/main`.
- **No debe:** asumir acceso a Electron/Node; un cambio de protocolo requiere actualizar `agent-worker.ts` y
  `ScopedCdpGateway` a la vez y pasar `npm run agent:compat`.
- **Empaquetado:** `forge.config.cjs` copia el binario congelado desde `agent-runtime/dist/<arch>/agent-host` (o
  `agent-runtime/test-stub` para E2E) — es el único punto donde el build raíz conoce esta área.
- **Pruebas al tocar esta área:** `npm run agent:test`, `npm run agent:build`, `npm run agent:compat`.

### `pocs/` — pruebas de concepto Electron aisladas
- **Responsabilidad:** validar comportamientos de bajo nivel de Electron/Chromium (canvas, gestos, popups, storage,
  agent-gateway) fuera de la app real.
- **Depende de:** solo Electron y Node; no importan `src/` compilado (cargan `.ts` puntual vía
  `pocs/lib/load-typescript.cjs` cuando lo necesitan). Es la zona de menor acoplamiento del repo — buena candidata
  para trabajo aislado.
- **No debe:** depender de `out/` ni de un bundle de webpack.
- **Pruebas al tocar esta área:** `npm run test:poc` (o el POC individual, `npm run test:poc:<nombre>`).

### `tests/`
- `tests/unit/` refleja la estructura de `src/` (un archivo de test por módulo); un cambio en `src/main/x.ts` o
  `src/renderer/components/Y.tsx` casi siempre trae su test correspondiente en el mismo cambio, no una tarea aparte.
- `tests/e2e/`, `tests/perf/`, `tests/bench/` ejercitan la app empaquetada/construida completa — dependen de `src/` y,
  para el escenario de agente, del sidecar de `agent-runtime`.
- `tests/support/` es compartido por los E2E (helpers de ventana/Playwright); trátelo como `src/shared`: cambios
  aquí afectan a todos los `.spec.ts`.

### `docs/`
- **Vivos** (se actualizan en el mismo PR que el comportamiento que describen): `architecture.md`,
  `security-model.md`, `security-audit.md`, `qa-inventory.md`, `release-checklist.md`.
- **`docs/adr/`**: decisiones arquitectónicas duraderas, un archivo por decisión — nunca se reescriben, solo se
  añaden nuevas.
- **`docs/audits/`**: auditorías de un barrido puntual (fecha fija, hallazgos numerados); ver
  [`docs/audits/README.md`](docs/audits/README.md). No son la fuente de verdad del estado actual.
- **`docs/design/`**, **`docs/poc-results/`**: especificación visual y evidencia de POC.

## Archivos globales / sensibles (evite tocarlos en paralelo)

Estos afectan a todas las áreas a la vez y son el punto más probable de conflicto entre worktrees o agentes
simultáneos; si una tarea no requiere cambiarlos, no los toque:

- `package.json`, `package-lock.json`, `tsconfig.json`
- `forge.config.cjs`, `webpack.main.config.cjs`, `webpack.renderer.config.cjs`, `webpack.rules.cjs`
- `eslint.config.mjs`, `playwright.config.ts`, `playwright.perf.config.ts`, `vitest.config.mts`, `vitest.bench.config.mts`
- `.github/workflows/ci.yml`
- `CHANGELOG.md` (archivo único de entradas; varias tareas en paralelo que lo editan chocan casi siempre —
  añada su entrada al final de la sección correspondiente y resuelva el conflicto por concatenación, no eligiendo un lado)

## Guía práctica para subagentes y worktrees

1. Asigne un worktree/agente por área (`src/main`, `src/renderer`, `agent-runtime`, `pocs`, `tests`+`docs`) cuando el
   trabajo lo permita; el grafo de llamadas real confirma acoplamiento bajo entre ellas salvo por `src/shared`.
2. Un cambio que solo toca `src/shared` para ampliar un contrato debe ir en la misma tarea que su consumidor en
   `main` o `renderer`, no repartido entre dos agentes.
3. Antes de fusionar trabajo de varias ramas, ejecute `npm run verify` (o `npm run test:all` si tocó agentes,
   POCs o E2E) sobre el resultado combinado, no solo por rama.
4. Antes de mover o renombrar cualquier archivo, busque sus referencias (`grep` de su ruta/nombre en `docs/`,
   `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md` y comentarios de test) y actualícelas en el mismo cambio.
