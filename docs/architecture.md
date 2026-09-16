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

Crear una vista es síncrono e idempotente por `browserId`: la vista se adjunta, se configura y su restauración se *inicia* sin esperar a que cargue la página. Cada navegación que inicia OmniBrowser incrementa un token; el fallback de restauración solo se aplica si ninguna navegación posterior lo ha sustituido. Así, repetir `wake`, suspender durante una carga o cerrar mientras se restaura no duplica vistas ni deja promesas pendientes, y ningún flujo depende de la red para terminar.

## Canvas y vistas nativas

La fuente de verdad de una tarjeta está en coordenadas world:

```text
screenX = viewportX + panX + worldX × zoom
screenY = viewportY + panY + worldY × zoom
screenW = worldW × zoom
screenH = worldH × zoom
```

El rectángulo Chromium de una tarjeta es su *content slot*: dentro del borde de 1 px, 38 px bajo el borde superior y 16 px del resto (`src/shared/geometry.ts`, con una prueba que compara las constantes con `styles.css` y otra anclada a la medición DOM real). React lo calcula a partir de la cámara, la medida del viewport y la geometría world, sin medir cada tarjeta en el DOM, y los bordes se redondean por arista para que dos rectángulos contiguos no deriven.

Las superficies nativas se componen **por encima de todo el shell**, así que una vista solo es visible si:

- no está suspendida ni caída y el zoom es de al menos 50 %;
- su content slot está completamente dentro del canvas (las tarjetas parcialmente fuera muestran el placeholder React);
- no la cubre el rectángulo exterior (cabecera, borde, handles y anillo de selección) de ninguna tarjeta con mayor z;
- no la cubre un overlay transitorio del canvas, como un aviso.

El minimapa cede: se oculta mientras una superficie visible cubre su esquina y vuelve cuando deja de estar cubierto. Una tarjeta ocluida muestra su título y dominio; al seleccionarla sube al frente y recupera el contenido vivo.

El renderer envía el layout con `requestAnimationFrame`, como máximo una petición en vuelo, descarta lotes intermedios y no reenvía lotes idénticos. El proceso principal solo llama a `setBounds`/`setVisible` cuando el valor cambia y solo marca el workspace para guardar si cambia la geometría world. Durante un gesto, los snapshots que llegan de main no sobrescriben la geometría local de la tarjeta arrastrada ni la cámara en pan.

El orden z es propiedad del proceso principal (crear, enfocar, adoptar popups) y se mantiene denso (1..n); el renderer aplica la misma regla de forma optimista (`src/shared/z-order.ts`). El orden nativo de las vistas vivas se sincroniza con el z-order. Pulsar dentro de una página (`input-event` nativo de tipo `mouseDown`, `touchStart` o `gestureTapDown`) selecciona y eleva su tarjeta. No se usa el evento `focus` del `WebContents`: también se emite por foco programático, por la creación de vistas y por `window.focus()`, y permitiría que una página en segundo plano robase la selección.

El canvas es enfocable: flechas para desplazar (Mayús para pasos largos), `+`/`-` para acercar o alejar y `0` para 100 %. Los botones de zoom escalan sobre el centro del canvas en pasos redondeados.

Por debajo de 50 %, Chromium se oculta y React representa tarjetas semánticas. Seleccionar una centra la tarjeta, cambia a 72 % y reconstruye/enseña su vista si corresponde.

## Persistencia

`WorkspaceStore` mantiene:

- `workspace.json`: estado activo versionado;
- `workspace.backup.json`: el último primario válido que OmniBrowser escribió o cargó, tomado de memoria y no del archivo en disco;
- `workspace[.backup].corrupt-<timestamp>-<id>.json`: primario o backup ilegible preservado sin cambios;
- `workspace[.backup].future-v<N>-<timestamp>-<id>.json`: archivo de un esquema más reciente preservado sin cambios.

Primario y backup se escriben con un temporal exclusivo `0600`, `fsync`, `rename` atómico y sincronización best-effort del directorio. La lectura usa `lstat` y `O_NOFOLLOW`, rechaza symlinks y archivos no regulares, aplica el límite de 10 MiB, ejecuta migraciones explícitas (`workspace-migrations.ts`) y valida con Zod. Ningún archivo existente que no se pueda leer se sobrescribe: se preserva antes de la primera escritura y el aviso indica su nombre. Si un workspace superase el límite de lectura, al guardar se recorta el historial antiguo alrededor de cada entrada activa. Las escrituras idénticas a la última se omiten y los temporales huérfanos de otros procesos se eliminan al cargar.

`SaveScheduler` agrupa los cambios estructurales con un debounce de 450 ms que nunca retrasa el guardado más de 2 s desde el primer cambio pendiente, de modo que la actividad continua no puede impedir que se guarde. Los cambios de bajo valor, como títulos o bounds de ventana, usan un retardo de 5 s que no pospone un guardado ya programado. Un fallo se refleja en el indicador, se registra y se reintenta con backoff hasta 30 s, sin rechazos sin manejar.

Se persiste:

- perfiles persistentes;
- tarjetas pertenecientes a esos perfiles;
- URL y título del historial, hasta 500 entradas por tarjeta; las entradas con esquema no permitido o URL de más de 4096 caracteres se descartan al capturarlas y el índice activo se reasigna;
- índice activo, geometría, z-order, suspensión, selección, cámara y bounds de ventana.

No se persiste `NavigationEntry.pageState`, contenido de formularios, scroll, cookies ni datos web. El almacenamiento web queda exclusivamente bajo control de Chromium.

## Arranque, lazy restore y cierre

1. El protocolo privilegiado `omnibrowser://app` se registra antes de `app.ready`.
2. Se fija `userData`: el directorio temporal de E2E si corresponde, `OmniBrowser Development` en ejecuciones no empaquetadas (en APFS sin distinción de mayúsculas, `omnibrowser` y `OmniBrowser` son la misma carpeta) o el valor por defecto en el paquete.
3. Se adquiere el bloqueo de instancia única; una segunda instancia termina y enfoca la ventana existente.
4. Se carga y valida el workspace.
5. Se crea la vista seleccionada no suspendida e inicia su carga en segundo plano; el shell carga sin esperar a la red. Un fallo de carga del frame principal se muestra como aviso (`did-fail-load`, salvo `ERR_ABORTED`).
6. El renderer proyecta el layout; las vistas visibles restantes se crean de forma perezosa y las demás quedan como tarjetas resumidas sin `WebContents`.
7. Salir (Cmd+Q, cierre de sesión, `SIGTERM`) y cerrar la ventana ejecutan el mismo apagado idempotente: capturar la navegación, forzar el JSON, `flushStorageData()`/`cookies.flushStore()` de las sesiones persistentes abiertas y liberar las vistas. Cada paso se ejecuta aunque falle el anterior. `before-quit` espera ese apagado y después reanuda la salida.

## Popups

`setWindowOpenHandler` valida el destino y devuelve `action: "allow"` con `createWindow` y `outlivesOpener: true`. Electron entrega un `WebContents` ya asociado al opener, incluso para `target="_blank"` sin `rel="opener"`; OmniBrowser comprueba que su `Session` coincide y lo adopta dentro de un nuevo `WebContentsView`. La tarjeta conserva opener, `postMessage` y cierre iniciado por la página. Como cada tarjeta es un elemento persistente del workspace, suspender, cerrar o reasignar la tarjeta de origen no destruye las tarjetas abiertas desde ella. No se crea una ventana remota privilegiada ni se degrada a `BrowserView`.

Si una página se bloquea, su vista se oculta, la tarjeta muestra "La vista dejó de responder" con la acción "Recargar" y el estado se reinicia al volver a navegar.

## Contrato IPC

La superficie pública se limita a `bootstrap`, perfiles, navegadores, workspace y una suscripción de eventos. Todos los argumentos cruzan esquemas Zod en main. El handler rechaza cualquier sender cuyo `webContents` o frame principal no sea el shell.

Cada handler responde con un resultado serializable `{ ok: true, value }` o `{ ok: false, error: { code, message } }`. Las entradas inválidas y los errores de dominio esperados (URL no permitida, navegador inexistente, nombre duplicado) llegan al shell como mensajes en español sin registrar un stack en main. Solo los errores inesperados se registran, y la UI recibe un mensaje genérico. El preload convierte los fallos en `Error` con el mensaje ya localizado.

Los snapshots enviados al shell no incluyen el historial de navegación; el renderer usa `canGoBack`/`canGoForward`.

Los eventos son discriminados: snapshot, estado de navegador, estado de guardado y aviso. El renderer nunca elige nombres de canal ni invoca IPC genérico.

## Rendimiento

- `backgroundThrottling` permanece activado.
- Los eventos de navegación, carga y título de cada página se agrupan en como máximo una captura y un evento al shell cada 250 ms.
- Un cambio de título no provoca layout, `setBounds` ni `setVisible`.
- Los bundles de producción se minifican y no incluyen source maps.
- Ocultar una vista usa `setVisible(false)` sin destruirla.
- Suspender destruye el `WebContents`, mantiene modelo/historial y lo recrea a demanda.
- No hay suspensión automática ni límite artificial de tarjetas hasta disponer de datos de más equipos.
- No se usa offscreen rendering.

Las mediciones de primitivas están en [poc-results](poc-results/README.md). Las de la aplicación completa, antes y después de la auditoría de 2026-09, están en [engineering-audit](engineering-audit.md) y se reproducen con `npm run test:perf`.
