# Arquitectura del MVP

## Objetivo y límites

El MVP es una aplicación macOS completamente local. Un único `BrowserWindow` aloja el shell React y cada navegador visible es un `WebContentsView` nativo. No hay servidor de aplicación, cuenta de usuario, telemetría ni sincronización.

```text
┌──────────────────────── Renderer confiable ────────────────────────┐
│ React: toolbar de canvas, árbol organizador, tarjetas y minimapa   │
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
| `WorkspaceModel` | invariantes de perfiles, browsers, zonas, stacks, orden, pins, presentación, cámara y proyección persistente | conocer `WebContents` o escribir archivos |
| `WorkspaceStore` | validación Zod, migración V1→V2, límite de tamaño, backups y reemplazo atómico | persistir perfiles Private o `pageState` |
| `ProfileSessionManager` | derivar partición, crear/reutilizar `Session` y hacer flush | copiar cookies o almacenamiento entre perfiles |
| `BrowserRuntime` | ciclo de vida de vistas, navegación, historial, popup, bounds y z-order | exponer contenido remoto al shell |
| `security-policy` | webPreferences, permisos, descargas y protocolos externos | conceder permisos implícitos |

## Flujo de perfil y almacenamiento

Un perfil persistente con ID `P` se traduce de forma determinista a:

```text
persist:omnibrowser-profile-P
```

Todas las tarjetas de `P` reciben la misma instancia lógica de `Session`. Chromium gestiona cookies, DOM storage, IndexedDB, Cache Storage, HTTP cache y service workers dentro de esa partición. OmniBrowser no replica cada API ni serializa su contenido.

Un perfil Private incorpora un UUID de lanzamiento y omite `persist:`:

```text
omnibrowser-private-<launch-id>-P
```

Ese perfil existe solo durante el proceso. `WorkspaceModel.toPersistentFile()` filtra el perfil y todos sus browsers, zonas, stacks, entradas de orden y pins antes de delegar a `WorkspaceStore`. Su historial necesario para Back/Forward vive únicamente en memoria.

Al reasignar una tarjeta:

1. se confirma el cambio en un diálogo nativo;
2. se captura la navegación actual; si se cruza el límite Private/persistente se reduce a una sola entrada con la URL actual;
3. se destruye el `WebContentsView` actual;
4. el modelo cambia `profileId`;
5. se crea la vista con la sesión de destino;
6. se restaura el historial sanitizado cuando el tipo de sesión no cambió o, en el cruce de privacidad, sólo la URL actual.

Crear una vista es síncrono e idempotente por `browserId`: la vista se adjunta, se configura y su restauración se *inicia* sin esperar a que cargue la página. Cada navegación que inicia OmniBrowser incrementa un token; el fallback de restauración solo se aplica si ninguna navegación posterior lo ha sustituido. Así, repetir `wake`, suspender durante una carga o cerrar mientras se restaura no duplica vistas ni deja promesas pendientes, y ningún flujo depende de la red para terminar.

## Canvas y vistas nativas

La fuente de verdad de un browser está en coordenadas world:

```text
screenX = viewportX + panX + worldX × zoom
screenY = viewportY + panY + worldY × zoom
screenW = worldW × zoom
screenH = worldH × zoom
```

El rectángulo Chromium de una card es su *content slot*: dentro del borde de 1 px, 38 px bajo el borde superior y 16 px del resto (`src/shared/geometry.ts`, con una prueba que compara las constantes con `styles.css` y otra anclada a la medición DOM real). React lo calcula a partir de la cámara, la medida del viewport y la geometría world, sin medir cada card en el DOM, y los bordes se redondean por arista para que dos rectángulos contiguos no deriven.

`worldRect` sigue siendo canónico para todos los modos. Minimize deriva una card compacta sin tocar tamaño; un pin de viewport deriva un rectángulo normalizado; full screen deriva bounds inmersivos y vive sólo en renderer. Al restaurar cualquiera de esos modos reaparecen la geometría y la cámara originales. Las zonas derivan su envolvente de los browsers miembros. Un stack hace que sus miembros compartan rectángulo, enseña sólo el miembro superior y los transforma como una unidad.

Las superficies nativas se componen **por encima de todo el shell**. `computeCanvasLayout` produce visibilidad, bounds y una capa `normal`, `pinned` o `immersive`; `BrowserRuntime` ordena primero por capa y después por z-index. Una vista solo es visible si:

- no está suspendida ni caída y el zoom es de al menos 50 %;
- su content slot está completamente dentro del canvas (las tarjetas parcialmente fuera muestran el placeholder React);
- no la cubre el rectángulo exterior (cabecera, borde, handles y anillo de selección) de ninguna tarjeta con mayor z;
- no la cubre un overlay del shell marcado como oclusor: avisos, toolbar de selección y navegación del canvas, fijos al viewport, el diálogo modal accesible `PromptModal` (`.native-occluder` con `data-occluder-type="prompt-modal"` que reemplaza al síncrono `window.prompt`), o etiquetas de zona, chips de zonas colapsadas y el menú de la tarjeta, que se dibujan dentro del mundo. Estos últimos se registran en coordenadas world y se proyectan con la cámara de cada layout, de modo que siguen ocluyendo en su nueva posición tras un pan o zoom;
- su zona no está colapsada, no está minimizada y, si pertenece a un stack, es su miembro superior.

El árbol React está protegido en su raíz por `ErrorBoundary` para aislar fallos de componentes sin provocar pantallas en blanco. Todas las comparaciones de rectángulos de layout y content slot emplean la utilidad centralizada `sameRect` de `src/shared/geometry.ts`.

El minimapa cede: se oculta mientras una superficie visible cubre su esquina y vuelve cuando deja de estar cubierto. Una tarjeta ocluida muestra su título y dominio; al seleccionarla sube al frente y recupera el contenido vivo.

El renderer envía el layout con `requestAnimationFrame`, como máximo una petición en vuelo, descarta lotes intermedios y no reenvía lotes idénticos. El proceso principal solo llama a `setBounds`/`setVisible` cuando el valor cambia y solo marca el workspace para guardar si cambia la geometría world. Durante un gesto, los snapshots que llegan de main preservan todos los rectángulos de la selección o stack transformado y la cámara durante pan.

El orden z es propiedad del proceso principal (crear, enfocar, adoptar popups) y se mantiene denso (1..n); el renderer aplica la misma regla de forma optimista (`src/shared/z-order.ts`). El orden nativo de las vistas vivas se sincroniza con el z-order. Pulsar dentro de una página (`input-event` nativo de tipo `mouseDown`, `touchStart` o `gestureTapDown`) selecciona y eleva su tarjeta. No se usa el evento `focus` del `WebContents`: también se emite por foco programático, por la creación de vistas y por `window.focus()`, y permitiría que una página en segundo plano robase la selección. Electron entrega esos eventos de ratón sin modificadores, así que el estado de Shift se sigue con `before-input-event` del shell y de cada página, y se reinicia cuando la ventana pierde el foco: Shift+pulsación dentro de una página alterna su tarjeta en la selección múltiple.

El canvas es enfocable: flechas para desplazar (Mayús para pasos largos), `+`/`-` para acercar o alejar, `0` para 100 %, minimapa, rueda en fondo y Space+drag. Shift+click y Shift+drag seleccionan múltiples browsers; movimiento y escala grupal se rechazan como unidad si existe un miembro bloqueado, fijado o incompatible. El snap opcional compara bordes y centros con un umbral de 8 px de pantalla sin mover vecinos ni imponer cuadrícula.

Los gestos que nacen dentro de una superficie Chromium requieren poder cancelar de forma fiable el evento antes de que la página haga scroll. Electron 44 no lo permite: `before-mouse-event` solo recibe pulsaciones (de `kMouseDown` a `kContextMenu`), `before-input-event` solo teclado, `input-event` observa la rueda sin poder cancelarla, `CanOverscrollContent()` es `false` y el evento `swipe` de la ventana solo cubre swipes discretos del modo antiguo de macOS. El POC `gesture-interception-gate` (`npm run test:poc:gestures`) mantiene comprobada esa premisa y una E2E fija el comportamiento publicado: la rueda sobre un browser, activo o no, solo desplaza su página, y sobre canvas vacío panea. Por eso el pan sobre browser inactivo y Back/Forward horizontal permanecen detrás de la compuerta de compatibilidad, sin toggle público: el contrato IPC solo acepta `historySwipeEnabled: false` y el modelo normaliza a `false` cualquier valor cargado. Reabrirla exige un hook cancelable en Electron (el POC fallará al aparecer) o no componer contenido vivo bajo el gesto, y después la matriz física en Apple Silicon e Intel ([hardening-2026-09](hardening-2026-09.md)). No existe un historial paralelo: cuando se habilite, usará `WebContents.navigationHistory`.

Por debajo de 50 %, Chromium se oculta y React representa tarjetas semánticas. Seleccionar una centra la tarjeta, cambia a 72 % y reconstruye/enseña su vista si corresponde.

## Agentes Browser Use por browser

Cada `BrowserRecord.id` es también el `browserId` estable de un agente. `AgentManager` vive en main y materializa una
relación exclusiva `browserId → agentId → chatSessionId → browserSession`; serializa las operaciones de cada browser,
admite una sola tarea activa por tarjeta, como máximo 20 instrucciones en su cola privada y cuatro tareas activas
globales. Los registros se crean al usar el agente de una tarjeta (abrir el panel solo crea un borrador en memoria), de
modo que un workspace con cientos de tarjetas no escribe un archivo por tarjeta al arrancar. Si el almacén de agentes no
se puede abrir, los agentes quedan desactivados con un aviso y el resto del workspace arranca con normalidad.

`BrowserRuntime` entrega descriptores efímeros `{ browserId, profileId, contentsId, targetId, runtimeEpoch, contents }`.
Cada recreación incrementa `runtimeEpoch`. `ScopedCdpGateway` adjunta el debugger únicamente a ese `WebContents`,
publica en loopback una capacidad aleatoria que solo representa ese target y filtra los comandos CDP:

- presenta un navegador virtual de una sola página: `Target.*` se virtualiza y anuncia los cambios de URL y título
  (`Target.targetInfoChanged`) que Browser Use usa para describir la página al modelo;
- aplica a `Page.navigate` la misma allowlist que la tarjeta (`https:`, `http:`, `about:blank`), porque una navegación
  iniciada por CDP no emite `will-navigate`; `BrowserRuntime` detiene además cualquier navegación de ese tipo hacia otro
  esquema y abandona el documento si llegara a confirmarse;
- deniega cookies, descargas, archivos locales (`Network.loadNetworkResource`, `DOM.setFileInputFiles`), pestañas,
  `Page.close`, `Page.crash` y el borrado del historial; `Page.bringToFront` no eleva la tarjeta;
- responde `Page.captureScreenshot` con `webContents.capturePage({ stayHidden: true })`: Chromium no produce frames para
  una vista oculta, así que la captura CDP nunca respondería con la tarjeta fuera de pantalla, tapada, minimizada o con la
  ventana oculta, y la página no observa ningún cambio de visibilidad. Mientras una navegación cambia la superficie del
  compositor, `capturePage` pierde uno o dos frames (`UnknownVizError` o imagen vacía); la pasarela los reintenta
  durante unos 400 ms, porque Browser Use captura justo después de navegar;
- marca los comandos `Input.*` como entrada sintética, de modo que un clic del agente no selecciona ni eleva su tarjeta.

El sidecar Browser Use recibe la capacidad y la configuración del modelo por stdin JSONL; ningún dato de control pasa por
React ni por argumentos del proceso. Todos los eventos vuelven etiquetados y se descartan si su epoch o IDs ya no
coinciden. Cada tarea nueva recibe como contexto los últimos turnos de la conversación de su tarjeta, y una tarea
interrumpida, los pasos que ya había completado. Los errores del sidecar llegan con un código que main traduce al
español; del diagnóstico solo se muestra el tipo de excepción, nunca contenido de la página.

El panel React divide el cuerpo de la tarjeta: la superficie nativa ocupa la columna izquierda y el chat la derecha
(`min(312px, 100%)`). Al abrirlo, una tarjeta libre se amplía hasta 680 unidades; una bloqueada o fijada al viewport
conserva su tamaño y, si la columna de la página queda por debajo de 160 unidades, oculta su vista nativa. Los límites de
la vista se calculan con la misma geometría que el resto de tarjetas (`agentSplitPaneWidth`), sin medir el DOM en cada
frame. El panel intercala conversación y actividad en orden, muestra cola, estado y controles Pause/Resume/Stop, y
cerrarlo no detiene el agente. El renderer sigue el estado de cada tarjeta por `agentId` y secuencia, así que el agente
nuevo que recibe una tarjeta al cambiar de perfil sustituye a la conversación anterior.

Los registros persistentes se guardan fuera de `workspace.json` en `userData/agents/<browserId>.json`; los Private
solo existen en memoria. La clave del proveedor se cifra con Electron `safeStorage` y solo se envía al origen para el que
se guardó: usar otro endpoint exige escribirla de nuevo. El llavero no se lee al arrancar, sino cuando una tarea o una
prueba necesita la clave. Si la persona desmarca «Recordar la clave en este Mac» o macOS deniega el llavero, la clave
queda solo en memoria de main hasta cerrar la app y `agent-provider.json` guarda únicamente la URL y el modelo. Una tarea viva durante cierre, suspensión, cambio de perfil,
caída de la página o destrucción del target queda pausada como interrumpida y solo continúa por acción explícita, con un
worker y una capacidad nuevos. `npm run agent:compat` ejecuta la traza de compatibilidad con la versión fijada de Browser
Use. Véase [ADR 0005](adr/0005-card-scoped-browser-use-agents.md).

## Persistencia

`WorkspaceStore` mantiene:

- `workspace.json`: estado activo versionado;
- `workspace.backup.json`: el último primario válido que OmniBrowser escribió o cargó, tomado de memoria y no del archivo en disco;
- `workspace.v1-backup.json`: copia única e inmutable del V1 válido antes de la primera escritura V2;
- `workspace[.backup].corrupt-<timestamp>-<id>.json`: primario o backup ilegible preservado sin cambios;
- `workspace[.backup].future-v<N>-<timestamp>-<id>.json`: archivo de un esquema más reciente preservado sin cambios.

Primario y backup se escriben con un temporal exclusivo `0600`, `fsync`, `rename` atómico y sincronización best-effort del directorio. La lectura usa `lstat` y `O_NOFOLLOW`, rechaza symlinks y archivos no regulares, aplica el límite de 10 MiB, ejecuta migraciones explícitas (`workspace-migrations.ts`) y valida con Zod. Ningún archivo existente que no se pueda leer se sobrescribe: se preserva antes de la primera escritura y el aviso indica su nombre. Si un workspace superase el límite de lectura, al guardar se recorta el historial antiguo alrededor de cada entrada activa. Las escrituras idénticas a la última se omiten y los temporales huérfanos de otros procesos se eliminan al cargar.

`SaveScheduler` agrupa los cambios estructurales con un debounce de 450 ms que nunca retrasa el guardado más de 2 s desde el primer cambio pendiente, de modo que la actividad continua no puede impedir que se guarde. Los cambios de bajo valor, como títulos o bounds de ventana, usan un retardo de 5 s que no pospone un guardado ya programado. Un fallo se refleja en el indicador, se registra y se reintenta con backoff hasta 30 s, sin rechazos sin manejar.

El esquema V2 persiste:

- perfiles persistentes;
- tarjetas pertenecientes a esos perfiles;
- URL y título del historial, hasta 500 entradas por tarjeta; las entradas con esquema no permitido o URL de más de 4096 caracteres se descartan al capturarlas y el índice activo se reasigna;
- índice activo, geometría, z-order, suspensión, selección, cámara y bounds de ventana;
- zonas/colapso, stacks, `browserOrder`, minimize, lock, pins y preferencias de snap/gestos.

No se persiste `NavigationEntry.pageState`, contenido de formularios, scroll, cookies, estados de audio/carga/descarga/error, favicon cache ni datos Private. El almacenamiento web queda exclusivamente bajo control de Chromium.

## Arranque, lazy restore y cierre

1. El protocolo privilegiado `omnibrowser://app` se registra antes de `app.ready`.
2. Se fija `userData`: el directorio temporal de E2E si corresponde, `OmniBrowser Development` en ejecuciones no empaquetadas (en APFS sin distinción de mayúsculas, `omnibrowser` y `OmniBrowser` son la misma carpeta) o el valor por defecto en el paquete.
3. Se adquiere el bloqueo de instancia única; una segunda instancia termina y enfoca la ventana existente.
4. Se carga y valida el workspace.
5. Se crea la vista seleccionada no suspendida e inicia su carga en segundo plano; el shell carga sin esperar a la red. Un fallo de carga del frame principal se muestra como aviso (`did-fail-load`, salvo `ERR_ABORTED`). Ese fallo puede llegar antes de que el shell se suscriba a eventos, igual que el aviso de un workspace recuperado: `ShellNotices` retiene los avisos (deduplicados durante 4 s, como máximo 20) y los entrega justo después de `bootstrap`. Si el documento del shell se recarga, vuelve a retenerlos hasta su nuevo `bootstrap`.
6. El renderer proyecta el layout; las vistas visibles restantes se crean de forma perezosa y las demás quedan como tarjetas resumidas sin `WebContents`.
7. Salir (Cmd+Q, cierre de sesión, `SIGTERM`) y cerrar la ventana ejecutan el mismo apagado idempotente: capturar la navegación, forzar el JSON, `flushStorageData()`/`cookies.flushStore()` de las sesiones persistentes abiertas, liberar las vistas —lo que cancela descargas— y limpiar storage/caché Private. Cada paso se ejecuta aunque falle el anterior. `before-quit` espera ese apagado y después reanuda la salida.

## Popups

`setWindowOpenHandler` valida el destino y devuelve `action: "allow"` con `createWindow` y `outlivesOpener: true`. Electron entrega un `WebContents` ya asociado al opener, incluso para `target="_blank"` sin `rel="opener"`; OmniBrowser comprueba que su `Session` coincide y lo adopta dentro de un nuevo `WebContentsView`. La tarjeta conserva opener, `postMessage` y cierre iniciado por la página. Como cada tarjeta es un elemento persistente del workspace, suspender, cerrar o reasignar la tarjeta de origen no destruye las tarjetas abiertas desde ella. No se crea una ventana remota privilegiada ni se degrada a `BrowserView`.

Si una página se bloquea, su vista se oculta, la tarjeta muestra "La vista dejó de responder" con la acción "Recargar" y el estado se reinicia al volver a navegar.

## Favicons y descargas

`BrowserRuntime` escucha `page-favicon-updated` y sólo acepta URLs HTTP(S) emitidas por ese `WebContents`. `FaviconCache` recupera con la `Session` del perfil, sigue como máximo cinco redirecciones HTTP(S), acepta únicamente AVIF/GIF/JPEG/PNG/WebP/ICO (SVG queda fuera), limita cada respuesta a 256 KiB y guarda hasta 256 entradas en memoria. El shell recibe una clave SHA-256 opaca y carga `omnibrowser://app/favicon/<key>` mediante el componente compartido `Favicon.tsx` (`src/renderer/components/Favicon.tsx`), proporcionando un icono fallback consistente de globo terráqueo; la CSP no se amplía a hosts remotos y la caché se destruye al cerrar.

Las descargas sólo se aceptan si `will-download` puede asociar el `webContents.id` a un browser registrado de esa misma sesión. Electron conserva el diálogo nativo con `setSaveDialogOptions`; OmniBrowser nunca llama a `setSavePath`, no conoce ni persiste la ruta elegida y sólo publica progreso agregado, agrupado a intervalos de 100 ms. Cerrar el browser, reasignarlo a otro perfil o salir de la aplicación cancela sus items activos y Chromium elimina el archivo parcial. Un archivo que el usuario ya aceptó puede permanecer en disco, también si provino de un perfil Private.

Mientras el diálogo de guardado espera respuesta, Chromium ya descarga en un temporal oculto (`.<bundle-id>.XXXXXX`) del directorio de descargas por defecto, porque Electron solo fija el destino al cerrar el diálogo. Salir con el diálogo abierto aborta la descarga y elimina el temporal; un cierre forzado o un crash en ese intervalo podría dejarlo, también para un perfil Private. Evitarlo (por ejemplo, pausar el item hasta conocer el destino) es una decisión de producto pendiente.

## Contrato IPC

La superficie pública se limita a `bootstrap`, perfiles, navegadores, workspace, agentes y una suscripción de eventos. Todos los argumentos cruzan esquemas Zod en main. El namespace `agents` solo acepta `browserId`, instrucciones y configuración del proveedor; no expone CDP ni credenciales. El handler rechaza cualquier sender cuyo `webContents` o frame principal no sea el shell.

Cada handler responde con un resultado serializable `{ ok: true, value }` o `{ ok: false, error: { code, message } }`. Las entradas inválidas y los errores de dominio esperados (URL no permitida, navegador inexistente, nombre duplicado) llegan al shell como mensajes en español sin registrar un stack en main. Solo los errores inesperados se registran, y la UI recibe un mensaje genérico. El preload convierte los fallos en `Error` con el mensaje ya localizado.

Los snapshots enviados al shell no incluyen el historial de navegación; el renderer usa `canGoBack`/`canGoForward`. Sí incluyen el estado agregado y transitorio de audio, carga, descarga, error y una clave opaca de favicon.

Los avisos de navegación o restauración de un browser Private son deliberadamente genéricos: no interpolan su dominio, URL ni título.

Los eventos son discriminados: snapshot, estado de browser, click nativo con modificador Shift, `Escape` nativo en superficie inmersiva, estado de guardado y aviso. El renderer nunca elige nombres de canal ni invoca IPC genérico.

## Registros de decisiones arquitectónicas (ADRs)

Para un análisis a fondo de los fundamentos y alternativas evaluadas, consulte:
- [ADR 0001: Motor Electron, WebContentsView y particiones por perfil](adr/0001-engine-and-profile-model.md)
- [ADR 0002: Persistencia atómica en disco y recuperación ante corrupción](adr/0002-atomic-persistence-and-corruption-recovery.md)
- [ADR 0003: Composición nativa WebContentsView en ventana única y gestión de oclusores](adr/0003-single-window-canvas-layout-and-native-occlusion.md)
- [ADR 0004: Política de compuerta de gestos y gestión de eventos de rueda no cancelables](adr/0004-gesture-gating-and-wheel-event-handling.md)
- [ADR 0005: agentes Browser Use aislados por tarjeta](adr/0005-card-scoped-browser-use-agents.md)

## Rendimiento

- `backgroundThrottling` permanece activado.
- Los eventos de navegación, carga y título de cada página se agrupan en como máximo una captura y un evento al shell cada 250 ms.
- Un cambio de título no provoca layout, `setBounds` ni `setVisible`.
- El árbol del sidebar preindexa browsers por perfil/zona/stack y resuelve miembros por `Map`, evitando filtros anidados; búsqueda y derivación se ejercitan con 500 browsers.
- Las filas del árbol y las tarjetas están memoizadas y reciben callbacks de identidad estable (`useEventCallback` y un objeto de acciones delegadas en el canvas), así que un evento de runtime o un frame de gesto solo re-renderiza lo que cambió, no las 500 filas y tarjetas.
- Medir los overlays oclusores fuerza layout; solo se repite cuando cambia la geometría dibujada, las zonas, los stacks, la selección, el menú, full screen o el umbral semántico, nunca por un título o un estado de carga.
- Los bundles de producción se minifican y no incluyen source maps.
- Ocultar una vista usa `setVisible(false)` sin destruirla.
- Suspender destruye el `WebContents`, mantiene modelo/historial y lo recrea a demanda.
- No hay suspensión automática ni límite artificial de tarjetas. Como ocultar no destruye, cada tarjeta que ha llegado a verse conserva su proceso (~100 MiB por página estática en Apple Silicon) hasta suspenderla; una política de suspensión automática cambia qué estado de página se conserva y es una decisión de producto pendiente.
- No se usa offscreen rendering.

Las mediciones de primitivas están en [poc-results](poc-results/README.md). Las de la aplicación completa están en [engineering-audit](engineering-audit.md) (auditoría de 2026-09) y en [hardening-2026-09](hardening-2026-09.md) (pasada posterior al canvas espacial); se reproducen con `npm run test:perf`, y las derivaciones puras con 500 browsers con `npm run bench`.
