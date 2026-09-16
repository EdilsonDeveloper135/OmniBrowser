# Contribuir a OmniBrowser

Gracias por ayudar a construir un navegador espacial local y auditable. Antes de abrir un cambio, lea la arquitectura, el ADR y el modelo de seguridad; la separación entre shell confiable, proceso principal y contenido remoto es una restricción de producto, no un detalle opcional.

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
- Una superficie Chromium nunca debe cubrir controles React: use `computeCanvasLayout` para cualquier overlay nuevo dentro del canvas.
- Los errores esperados del IPC son `OmniUserError` con mensaje en español; no lance errores genéricos por entradas de usuario.

## Tests esperados

- Cambios puros de dominio/geometría/URL: test unitario.
- Sesión, partición, storage, popup o lifecycle: POC o integración Electron.
- Flujo visible, restauración o canvas: E2E pequeño y determinista. Los escenarios de lifecycle van en `tests/e2e/runtime-regressions.spec.ts`, con una instancia y un `userData` propios por prueba.
- Una prueba de regresión debe fallar contra el código anterior a la corrección; compruébelo antes de abrir el PR.
- Rendimiento: `npm run test:perf` antes y después del cambio en la misma máquina; publique las cifras como observaciones, no como gates.
- Cambio visual: captura actualizada y entrada en el ledger de fidelidad.
- Cambio de Electron: los cuatro POC en arm64 y x64, más actualización del ADR.

## Pull requests

Mantenga cada PR enfocado. Explique el problema y el límite de confianza afectado antes de describir la solución. Señale explícitamente cualquier escenario no ejecutado, arquitectura no disponible o permiso manual necesario.

No incluya artefactos de `out/`, `.webpack/`, reportes Playwright, secretos de firma o datos `userData`.

Al contribuir acepta el [Código de conducta](CODE_OF_CONDUCT.md) y que su contribución se publique bajo la [licencia MIT](LICENSE).
