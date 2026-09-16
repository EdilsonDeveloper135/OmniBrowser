# Arquitectura del MVP

## Objetivo y límites

El MVP es una aplicación macOS completamente local. Un único `BrowserWindow` aloja el shell React y cada navegador visible es un `WebContentsView` nativo. No hay servidor de aplicación, cuenta de usuario, telemetría ni sincronización.

```text
┌──────────────────────── Renderer confiable ────────────────────────┐
│ React: toolbar, rail de perfiles, tarjetas, canvas y minimapa      │
│   window.omniBrowser (API inmutable expuesta por preload)          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ invoke/event IPC, esquemas Zod
┌──────────────────────────────▼──────────────────────────────────────┐
│ Main process                                                        │
│  OmniBrowserController                                              │
│   ├─ WorkspaceModel ── SaveScheduler ── WorkspaceStore              │
│   ├─ ProfileSessionManager ── Session por perfil                    │
│   └─ BrowserRuntime ── WebContentsView por tarjeta                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ contenido web no confiable
              ┌────────────────▼────────────────┐
              │ Chromium renderer(s) sandboxed │
              └─────────────────────────────────┘
```

## Responsabilidades

| Módulo | Responsabilidad | No debe hacer |
|---|---|---|
| `src/renderer` | interacción y proyección visual del workspace | acceder a Node, Electron o datos Chromium directamente |
| `src/preload` | bridge mínimo tipado e inmutable | exponer `ipcRenderer`, canales arbitrarios o objetos Electron |
| `src/main/ipc` | registrar la allowlist de comandos y validar el sender | aceptar mensajes de vistas remotas |
| `WorkspaceModel` | invariantes de perfiles, tarjetas, cámara y proyección persistente | conocer `WebContents` o escribir archivos |
| `WorkspaceStore` | validación Zod, límite de tamaño, backup y reemplazo atómico | persistir perfiles temporales o `pageState` |
| `ProfileSessionManager` | derivar partición, crear/reutilizar `Session` y hacer flush | copiar cookies o almacenamiento entre perfiles |
| `BrowserRuntime` | ciclo de vida de vistas, navegación, historial, popup, bounds y z-order | exponer contenido remoto al shell |
| `security-policy` | webPreferences, permisos, descargas y protocolos externos | conceder permisos implícitos |

## Flujo de perfil y almacenamiento

Un perfil persistente con ID `P` se traduce de forma determinista a:

```text
persist:omnibrowser-profile-P
```

Todas las tarjetas de `P` reciben la misma instancia lógica de `Session`. Chromium gestiona cookies, DOM storage, IndexedDB, Cache Storage, HTTP cache y service workers dentro de esa partición. OmniBrowser no replica cada API ni serializa su contenido.

Un perfil temporal incorpora un UUID de lanzamiento y omite `persist:`:

```text
omnibrowser-temp-<launch-id>-P
```

Ese perfil existe solo durante el proceso. `WorkspaceModel.toPersistentFile()` filtra tanto el perfil como todas sus tarjetas antes de delegar a `WorkspaceStore`.

Al reasignar una tarjeta:

1. se confirma el cambio en un diálogo nativo;
2. se captura historial como `{ url, title }` e índice activo;
3. se destruye el `WebContentsView` actual;
4. el modelo cambia `profileId`;
5. se crea la vista con la sesión de destino;
6. se restaura el historial sanitizado o, si falla, la última URL permitida.

Las creaciones concurrentes se serializan por `browserId`: una navegación no puede usar una vista hasta terminar su restauración inicial.

## Canvas y vistas nativas

La fuente de verdad de una tarjeta está en coordenadas world:

```text
screenX = viewportX + panX + worldX × zoom
screenY = viewportY + panY + worldY × zoom
screenW = worldW × zoom
screenH = worldH × zoom
```

React transforma el chrome de la tarjeta y mide el rectángulo interior mediante `getBoundingClientRect()`. Envía un lote validado al proceso principal; `BrowserRuntime` aplica esos límites al `WebContentsView`. La vista se oculta si está suspendida, completamente fuera del viewport o el zoom es menor a 50 %.

El encabezado y los bordes pertenecen a React. El rectángulo Chromium usa un inset para que una superficie nativa nunca tape los controles de drag/resize. Seleccionar una tarjeta actualiza `zIndex` y vuelve a añadir su vista hija, elevándola en el orden nativo.

Por debajo de 50 %, Chromium se oculta y React representa tarjetas semánticas. Seleccionar una centra la tarjeta, cambia a 72 % y reconstruye/enseña su vista si corresponde.

## Persistencia

`WorkspaceStore` mantiene:

- `workspace.json`: estado activo versionado;
- `workspace.backup.json`: último primario válido;
- `workspace.corrupt-<timestamp>.json`: primario inválido preservado para diagnóstico.

La escritura usa un temporal exclusivo con permisos `0600`, `fsync`, `rename` atómico y sincronización best-effort del directorio. El JSON se valida antes y después de leer. La recuperación intenta primario, luego backup y finalmente un workspace nuevo, mostrando un aviso al usuario.

Se persiste:

- perfiles persistentes;
- tarjetas pertenecientes a esos perfiles;
- URL y título del historial, hasta 500 entradas por tarjeta;
- índice activo, geometría, z-order, suspensión, selección, cámara y bounds de ventana.

No se persiste `NavigationEntry.pageState`, contenido de formularios, scroll, cookies ni datos web. El almacenamiento web queda exclusivamente bajo control de Chromium.

## Arranque, lazy restore y cierre

1. El protocolo privilegiado `omnibrowser://app` se registra antes de `app.ready`.
2. Se carga y valida el workspace.
3. Se crea solo la vista seleccionada no suspendida.
4. El renderer proyecta el layout; las vistas visibles restantes se crean de forma perezosa.
5. Al cerrar se captura navegación, se fuerza el JSON, se hace `flushStorageData()`/`cookies.flushStore()` para perfiles persistentes y después se destruyen vistas.

## Popups

`setWindowOpenHandler` valida el destino y devuelve `action: "allow"` con `createWindow`. Electron entrega un `WebContents` ya asociado al opener; OmniBrowser comprueba que su `Session` coincide y lo adopta dentro de un nuevo `WebContentsView`. La tarjeta conserva opener, `postMessage` y cierre iniciado por la página. No se crea una ventana remota privilegiada ni se degrada a `BrowserView`.

## Contrato IPC

La superficie pública se limita a `bootstrap`, perfiles, navegadores, workspace y una suscripción de eventos. Todos los argumentos cruzan esquemas Zod en main. El handler rechaza cualquier sender cuyo `webContents.id` o frame no sea el shell principal.

Los eventos son discriminados: snapshot, estado de navegador, estado de guardado y aviso. El renderer nunca elige nombres de canal ni invoca IPC genérico.

## Rendimiento

- `backgroundThrottling` permanece activado.
- Ocultar una vista usa `setVisible(false)` sin destruirla.
- Suspender destruye el `WebContents`, mantiene modelo/historial y lo recrea a demanda.
- No hay suspensión automática ni límite artificial de tarjetas hasta disponer de datos de más equipos.
- No se usa offscreen rendering.

Las mediciones reproducibles del equipo de referencia están en [poc-results](poc-results/README.md).
