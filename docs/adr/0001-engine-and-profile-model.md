# ADR 0001: Electron, WebContentsView y particiones por perfil

- Estado: aceptado para el MVP; x64 es gate de CI antes de release
- Fecha: 2026-09-16
- Decisores: mantenedores de OmniBrowser

## Contexto

OmniBrowser necesita componer múltiples navegadores Chromium dentro de un canvas, compartir todo el almacenamiento web entre vistas del mismo perfil, aislar perfiles diferentes, persistir sesiones localmente y adoptar popups de autenticación sin perder la relación con `window.opener`.

La decisión no podía basarse solo en cookies. Debían probarse cookies persistentes y de sesión, `localStorage`, IndexedDB, Cache Storage, caché HTTP, service workers, persistencia entre procesos, perfiles efímeros, reasignación de tarjeta, geometría nativa y popups.

## Decisión

Usar Electron 44.4.1 con Chromium, TypeScript/React y Electron Forge/Webpack. El shell vive en un único `BrowserWindow` y cada navegador remoto en un `WebContentsView`.

- Perfil persistente: `session.fromPartition("persist:omnibrowser-profile-<uuid>", { cache: true })`.
- Perfil temporal: partición sin `persist:` y con UUID de lanzamiento.
- Una misma partición se reutiliza; el almacenamiento no se copia manualmente.
- Cambiar de perfil destruye/recrea la vista.
- Los popups se adoptan usando el `WebContents` entregado a `createWindow`.
- `BrowserView` y `<webview>` quedan prohibidos.

Documentación de referencia: [Electron Session](https://www.electronjs.org/docs/latest/api/session), [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [View](https://www.electronjs.org/docs/latest/api/view), [window.open](https://www.electronjs.org/docs/latest/api/window-open), [NavigationHistory](https://www.electronjs.org/docs/latest/api/navigation-history) y [Security checklist](https://www.electronjs.org/docs/latest/tutorial/security).

## Gates ejecutados

| Gate | Resultado arm64 | Criterio observado |
|---|---|---|
| almacenamiento/perfiles | pasa | A/B comparten almacenamiento durable; C aislado; sesión cookie desaparece; temp desaparece; reasignación funciona |
| canvas nativo | pasa | pan/zoom/bounds/Retina, ocultamiento y elevación por re-add |
| popup/opener | pasa | misma sesión, opener, `postMessage`, navegación y `window.close` |
| recursos/suspensión | pasa | métricas 1/5/10, ocultamiento, destrucción y wake con perfil/URL/historial |

Entorno validado: macOS 27.0, Apple M4 Pro arm64, 48 GiB, Electron 44.4.1. El gate x64 se ejecuta en `macos-15-intel`; no se declara aprobado localmente.

## Alternativas consideradas

### CEF + C++/Swift

`CefRequestContext` y windowless rendering satisfacen el modelo técnico y son el plan de contingencia si Electron rompe popup/opener o composición. El coste de framework, bindings, empaquetado y ownership de renderizado es mayor para el MVP. Referencias: [CefRequestContext](https://cef-builds.spotifycdn.com/docs/145.0/classCefRequestContext.html), [windowless rendering](https://cef-builds.spotifycdn.com/docs/116.0/classCefWindowInfo.html).

### Swift + WKWebView

`WKWebsiteDataStore` permite data stores persistentes, pero cambia el requisito de Chromium por WebKit. Es una opción macOS-native futura, no la base de este MVP. Referencia: [WKWebsiteDataStore](https://developer.apple.com/documentation/webkit/wkwebsitedatastore).

### Tauri + Rust

Reduce parte del shell, pero en macOS usa WebKit y la creación avanzada de datastores/webviews no ofrece una ventaja frente a WKWebView para este requisito. Referencia: [Tauri WebviewBuilder](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html).

### Qt WebEngine

`QWebEngineProfile` es una alternativa Chromium válida con perfiles persistentes/off-the-record. Implica migrar UI y runtime a C++/QML sin resolver una carencia demostrada de Electron. Referencia: [QWebEngineProfile](https://doc.qt.io/qt-6/qwebengineprofile.html).

## Consecuencias

Positivas:

- las primitivas de Chromium gestionan el conjunto completo de almacenamiento;
- TypeScript se comparte entre contratos, shell y main;
- el POC y el runtime usan el mismo mecanismo de sesión;
- el canvas conserva contenido Chromium nativo y sandboxed.

Costes y riesgos:

- cada vista activa puede implicar procesos/working set relevantes;
- una vista nativa no participa del stacking CSS ordinario;
- OAuth puede rechazar un user agent embebido aunque la sesión sea correcta;
- Playwright Electron es experimental;
- cambios de Electron requieren repetir los cuatro POC antes de actualizar la versión fijada.

## Regla de reconsideración

Abrir un ADR de CEF antes de ampliar el producto si una versión necesaria de Electron no puede preservar de manera determinista popup/opener, aislamiento de particiones o bounds/z-order tras dos intentos de mitigación documentados.
