# Contribuir a OmniBrowser

Gracias por ayudar a construir un navegador espacial local y auditable. Antes de abrir un cambio, lea la arquitectura ([`docs/architecture.md`](docs/architecture.md)), los registros de decisiones ([`docs/adr/`](docs/adr/)) y el modelo de seguridad ([`docs/security-model.md`](docs/security-model.md)); la separación entre shell confiable, proceso principal y contenido remoto es una restricción de producto, no un detalle opcional.

## Entorno

```bash
git clone https://github.com/EdilsonDeveloper135/OmniBrowser.git
cd OmniBrowser
nvm use
npm ci
npm start
```

Se requiere macOS 13+, Node 24.21.0 y npm 11.19.0. Si el Node del sistema es otra versión, active la de `.nvmrc` antes de `npm ci`. En macOS, exporte `SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"`, igual que la CI. Mantenga versiones directas exactas y actualice `package-lock.json` en el mismo PR que cambie dependencias. Un override en `package.json` requiere comprobar la API que usa cada consumidor y documentarlo en `docs/security-audit.md`.

`npm start` usa su propio `userData` (`OmniBrowser Development`) y nunca el de la app instalada.

## Antes de enviar un PR

```bash
npm run verify
npm run test:poc
npm run test:e2e
npm audit --omit=dev
```

Si el cambio toca los agentes (`src/main/agents/`, `agent-runtime/` o su panel), añada:

```bash
npm run agent:test
npm run agent:build
OMNIBROWSER_AGENT_PYTHON=agent-runtime/.venv-arm64/bin/python npm run agent:compat
```

Con el sidecar construido, `npm run test:e2e` ejecuta también la tarea completa del agente contra un modelo local; sin él, esa prueba se omite. `npm run package` y `npm run make` necesitan el sidecar de la arquitectura que empaquetan.

No use credenciales reales, cookies exportadas ni cuentas personales en fixtures, capturas o logs. Las pruebas deben usar el servidor local incluido.

## Convenciones de implementación

- Toda entrada IPC se valida en main con Zod.
- El preload expone operaciones concretas, nunca `ipcRenderer` genérico.
- Ninguna página remota recibe Node.js, preload del shell o privilegios adicionales.
- Un perfil se representa mediante una partición Chromium; no copie cookies/IndexedDB manualmente.
- Los perfiles temporales y sus tarjetas no pueden entrar al JSON persistido.
- El historial propio se limita a URL/título; no persista `pageState`.
- Mantenga `backgroundThrottling` activado.
- Use `navigationHistory` en lugar de APIs de navegación deprecadas.
- No introduzca `BrowserView`, `<webview>` ni `file://` para el shell.
- Conserve el canvas accesible a 1040×680, con `prefers-reduced-motion` y manejable por teclado.
- Una superficie Chromium nunca debe cubrir controles React: use `computeCanvasLayout` para cualquier overlay nuevo dentro del canvas y márquelo con `native-occluder`. Si el overlay se dibuja dentro de `.canvas-world` se registra en coordenadas world y sigue a la cámara; si se añade estado que lo muestre o lo mueva, inclúyalo en las dependencias de la medición de oclusores de `WorkspaceCanvas`.
- Diálogos y prompts de interacción: no utilice `window.prompt()` síncrono. Utilice el componente accesible `PromptModal` (que porta la clase `.native-occluder` y `data-occluder-type="prompt-modal"`), permitiendo que las vistas Chromium debajo se oculten mientras el diálogo esté abierto.
- Manejo de fallos en el shell: todo componente o árbol de UI crítico en React debe aislarse mediante `ErrorBoundary` para evitar pantallas en blanco.
- Comparaciones geométricas: utilice la utilidad unificada `sameRect` de `src/shared/geometry.ts` en lugar de comparaciones manuales de rectángulos.
- Favicons: utilice el componente compartido `Favicon.tsx` para una renderización uniforme de iconos de sitios y fallback a globo terráqueo.
- Las tarjetas y las filas del árbol están memoizadas: páseles callbacks estables (`useEventCallback` o el objeto de acciones del canvas) y datos cuya identidad solo cambie cuando cambia su contenido.
- Los avisos al shell pasan por `ShellNotices`, que los retiene hasta que el shell hace `bootstrap`; no emita eventos `notice` directamente.
- No publique gestos ni preferencias que dependan de cancelar la rueda dentro de un `WebContentsView` mientras el POC `gesture-interception-gate` pase.
- Los errores esperados del IPC son `OmniUserError` con mensaje en español; no lance errores genéricos por entradas de usuario.
- Agentes: el renderer solo nombra un `browserId`; targets, capacidades CDP, workers y claves nunca salen de main. Un método CDP nuevo solo entra en el allowlist de `ScopedCdpGateway` con una prueba negativa y la traza `npm run agent:compat`; una navegación o entrada iniciada por CDP debe respetar las mismas reglas que la del usuario.

## Tests esperados

- Cambios puros de dominio/geometría/URL o componentes React aislados: test unitario o de componente con Vitest (`tests/unit/`, con cobertura mediante `@vitest/coverage-v8`).
- Sesión, partición, storage, popup o lifecycle: POC o integración Electron.
- Flujo visible, restauración o canvas: E2E pequeño y determinista. Los escenarios de lifecycle van en `tests/e2e/runtime-regressions.spec.ts`, con una instancia y un `userData` propios por prueba.
- Una prueba de regresión debe fallar contra el código anterior a la corrección; compruébelo antes de abrir el PR.
- Rendimiento: `npm run test:perf` antes y después del cambio en la misma máquina, repetido al menos dos veces, y `npm run bench` si toca derivaciones puras; publique las cifras como observaciones, no como gates. En Apple Silicon el tiempo de pared de layout depende de si el hilo corre en núcleos de rendimiento o de eficiencia: compare también script y tarea total antes de atribuir una regresión.
- Cambio visual: captura actualizada y entrada en el ledger de fidelidad. `OMNIBROWSER_UPDATE_VISUAL_EVIDENCE=1` reemplaza las evidencias versionadas; la del POC de canvas exige una captura compuesta, que en macOS necesita permiso de grabación de pantalla para la terminal (`OMNIBROWSER_REQUIRE_COMPOSITE_CAPTURE=1` convierte su ausencia en error, como en CI).
- Cambio de Electron: los cinco POC en arm64 y x64, más actualización de los ADRs (`docs/adr/`). Si falla `gesture-interception-gate`, revise la compuerta de gestos de `docs/architecture.md` y `docs/adr/0004-gesture-gating-and-wheel-event-handling.md` antes de tratarlo como regresión.

## Pull requests

Mantenga cada PR enfocado. Explique el problema y el límite de confianza afectado antes de describir la solución. Señale explícitamente cualquier escenario no ejecutado, arquitectura no disponible o permiso manual necesario.

No incluya artefactos de `out/`, `.webpack/`, reportes Playwright, secretos de firma o datos `userData`.

Al contribuir acepta el [Código de conducta](CODE_OF_CONDUCT.md) y que su contribución se publique bajo la [licencia MIT](LICENSE).
