# QA inventory del MVP

Este inventario vincula cada afirmación visible del MVP con una comprobación funcional y una evidencia visual. El almacenamiento profundo (IndexedDB, Cache Storage, service workers y caché HTTP) se cubre en los POC deterministas; la suite E2E cubre el flujo completo de la aplicación.

| Área | Estado o control | Comprobación funcional | Evidencia visual |
|---|---|---|---|
| Arranque | shell, perfil Personal, perfil Private y primer browser | bootstrap tipado; un browser inicial | captura principal, 1440×900 |
| Perfiles | crear persistente y Private; seleccionar | Trabajo persiste; Descartable y todos sus datos organizativos desaparecen al reiniciar | árbol del sidebar |
| Sesión compartida | dos tarjetas Trabajo | cookie durable, cookie de sesión y localStorage visibles en ambas | títulos/etiquetas de tarjetas |
| Aislamiento | tarjeta Personal frente a Trabajo | Personal no lee datos de Trabajo; reasignar recrea la vista | encabezados con perfil |
| Navegación | URL, atrás, adelante, detener y recargar en header activo | fixture local y contador de solicitudes; browser inactivo muestra sólo dominio | header de card |
| Seguridad URL | `javascript:` | rechazo y aviso visible | toast revisado durante E2E |
| Canvas | mover, ocho handles de resize, pan, teclado, minimapa, lock y snap opcional | geometría/cámara persistidas; lock rechaza transformaciones; snapping unitario por borde/centro | captura principal postinteracción |
| Rueda y gestos | rueda o trackpad sobre un browser activo o inactivo; rueda sobre canvas vacío | la rueda sobre un browser solo desplaza su página (cámara, geometría y selección intactas); sobre canvas vacío panea; ningún hook de Electron cancela la rueda antes de la página | `runtime-regressions.spec.ts`; POC `gesture-interception-gate` |
| Modos | full screen, minimize y pin al viewport | full screen/Escape —también con foco dentro del `WebContents`— y minimize restauran `worldRect`; el pin no se mueve con la cámara y unpin vuelve al canvas | `runtime-regressions.spec.ts` |
| Organización | zonas, colapso y stacks | las zonas ocultan/recuperan vistas; un stack enseña sólo el miembro superior y unstack separa miembros | `runtime-regressions.spec.ts` |
| Selección múltiple | Shift+click en headers, marquesina, Shift+pulsación dentro de una página, movimiento/escala y acciones masivas | la marquesina selecciona las tarjetas que toca; Shift dentro de una página añade o quita su tarjeta y una pulsación simple deja solo esa; movimiento y lock atómicos; snapshot merge conserva todos los rectángulos activos | `runtime-regressions.spec.ts`, unitarias |
| Sidebar | árbol de perfiles/zonas/stacks, fijados, contadores, búsqueda, estados, cierre, ordenar y localizar | drag reorder, pin, búsqueda local, zoom-to-browser offscreen y cierre sincronizados | `runtime-regressions.spec.ts` |
| Zoom | botones y modo semántico <50% | tres tarjetas semánticas; seleccionar vuelve a 72%; el cambio de modo se detecta por la capa visible, sin número fijo de clics | `implementation-semantic-zoom-arm64.png` |
| Suspensión | suspender y reactivar | destrucción/recreación y estado awake | placeholder de reposo revisado durante E2E |
| Persistencia | guardar, cerrar y relanzar | perfiles/tarjetas durables vuelven; cookie de sesión no | captura principal y estado restaurado |
| Ventana mínima | 1040×680 | regiones esenciales dentro del viewport, sin scroll | `implementation-minimum-window-arm64.png` |
| Vista densa | tres navegadores superpuestos | z-order/foco y minimapa | `implementation-primary-arm64.png` |
| Alineación nativa | pan por arrastre y rueda, arrastre, resize, teclado | error ≤ 1 DIP entre `WebContentsView` y content slot | `runtime-regressions.spec.ts` |
| Oclusión | tarjeta superior, minimapa, aviso visible, menú de tarjeta abierto y etiqueta de zona tras un pan | ninguna superficie visible cubre controles React; las vistas cubiertas por el menú vuelven al cerrarlo; los overlays del mundo siguen ocluyendo en su nueva posición | `runtime-regressions.spec.ts`, `geometry.test.ts` |
| Resiliencia | arranque sin red, aviso emitido antes de que el shell se suscriba, crash del renderer, URL remota > 4096, título que cambia sin parar | el shell arranca y muestra el aviso aunque su script cargue tarde, la tarjeta se recupera y el workspace se guarda | `runtime-regressions.spec.ts`, `shell-notices.test.ts` |
| Lifecycle | wake/sleep/close repetidos, popups tras suspender/cerrar el opener, quit, segunda instancia | sin vistas duplicadas ni tarjetas perdidas; el proceso termina y conserva el estado | `runtime-regressions.spec.ts` |
| Seguridad remota | bridge, Node.js, `omnibrowser://`, CORS, permisos, `<webview>`, CSP del shell, bucle de `mailto:` | todo bloqueado o denegado; un solo diálogo externo | `runtime-regressions.spec.ts` |
| Favicons | caché local opaca | esquema/redirecciones/allowlist raster-ICO/tamaño limitados; SVG rechazado y CSP sin ampliar | `favicon-cache.test.ts` |
| Descargas | sólo browser registrado y diálogo del sistema | progreso agregado sin nombre ni carpeta en snapshots, `userData`, logs ni consola; cerrar el browser, pasar un browser Private a un perfil persistente o salir cancela y borra el parcial | `security-policy.test.ts`, `runtime-regressions.spec.ts`; diálogo manual |
| Rastros Private | cookie, `localStorage`, `sessionStorage`, IndexedDB, título, URL y descarga de una página Private | tras salir y tras reiniciar, nada de eso aparece en `userData` (UTF-8 y UTF-16LE) y el archivo aceptado sigue en su carpeta | `runtime-regressions.spec.ts` |
| Preferencias no publicadas | `historySwipeEnabled` | el IPC rechaza `true` y un valor `true` en disco se carga como `false` | `workspace-model.test.ts` |
| Migración | V1→V2 y recuperación | defaults, filtrado legacy Temporal y copia `workspace.v1-backup.json` 0600 que no se sobrescribe | `workspace-store.test.ts` |
| Rendimiento organizativo | árbol, búsqueda, snap, pan, eventos de runtime y vistas retenidas con 500 browsers | derivación lineal funcional; frames, hilo principal, CPU, IPC y memoria como observaciones reproducibles sin gate de tiempo | `sidebar-tree.test.ts`, `npm run test:perf`, `npm run bench` |
| Entradas inválidas | búsqueda implícita, vacío, > 4096, `javascript:`, `file:` | mensajes en español sin excepciones en main | `runtime-regressions.spec.ts` |

Escenarios exploratorios incluidos: URL con esquema bloqueado; reasignación de perfil ida/vuelta; suspensión seguida de reactivación; reinicio con estado Private y durable mezclados; reducción a ventana mínima después de restaurar.

## Compuertas manuales

Estado a 2026-09-17 ([hardening-2026-09](hardening-2026-09.md)). Se ejecutan con la app empaquetada, un `userData` nuevo y la fixture local; una casilla solo se marca con la arquitectura, el sistema y el resultado anotados.

### Trackpad físico en Apple Silicon e Intel

Estado: **no ejecutado**. No hay Mac Intel disponible y el control de la UI no se autorizó en la sesión de hardening.

Verifica el comportamiento publicado, no habilita gestos:

1. Abrir dos browsers con páginas largas y seleccionar uno.
2. Desplazar con dos dedos sobre el browser seleccionado y después sobre el otro: solo se desplaza la página bajo el puntero; la cámara, la selección y la geometría no cambian.
3. Desplazar con dos dedos sobre canvas vacío: panea el canvas y ninguna página se desplaza.
4. Deslizar en horizontal desde el borde de una página con historial: no navega Atrás ni Adelante y, si la página es más ancha que la vista, solo se desplaza.
5. Repetir con inercia y con la ventana en otra pantalla, y anotar cualquier doble desplazamiento.

### Historial horizontal y pan sobre browser inactivo

Estado: **compuerta cerrada**, sin toggle público. Electron 44.4.1 no permite cancelar la rueda antes de la página. Solo se evalúa si el POC `gesture-interception-gate` deja de pasar en una versión nueva de Electron o si el producto deja de componer contenido vivo bajo el gesto. En ese caso, en ambas arquitecturas, debe demostrarse inicio en el borde, predominio horizontal, una sola navegación por gesto y ausencia de scroll simultáneo antes de publicar nada.

### Diálogo nativo de descarga

Estado: **automatizado sin el diálogo; clics pendientes**. Las E2E sustituyen el diálogo por `setSavePath` y una sonda sin UI comprobó que salir con el diálogo abierto elimina el temporal.

Con un perfil persistente y con uno Private, anotando antes y después los archivos ocultos `.<bundle-id>.*` de `~/Downloads`:

1. Descargar desde la fixture y pulsar **Guardar** en otra carpeta: el archivo queda allí y no quedan temporales.
2. Descargar y pulsar **Cancelar**: no queda archivo ni temporal y la tarjeta vuelve a estado sin descargas.
3. Con el diálogo abierto, cerrar el browser; repetir saliendo de la app: no quedan temporales.
4. En Private, guardar un archivo, salir y relanzar: el archivo sigue en la carpeta elegida, pero ni el perfil ni su URL, título o nombre de archivo aparecen en la app ni en `userData`.
5. En ningún caso aparece la ruta elegida en `workspace.json`, en los avisos ni en la salida del proceso.

### Revisión visual humana

Estado: **automatizado; revisión humana pendiente**. Full screen y Escape dentro de contenido nativo, minimapa, zonas colapsadas, stacks y pins, restauración V1→V2 y reinicio sin rastros Private están cubiertos por E2E en arm64 local, con teclado y ratón sintéticos; falta repetirlos con teclado, ratón y trackpad reales. En x64 los ejecutará CI (`macos-15-intel`) al publicar la rama.

El Browser integrado de Codex sirve para páginas web, pero no puede inspeccionar la composición `WebContentsView` de una aplicación Electron. Para estas comprobaciones se usa Playwright Electron contra el bundle de producción y se comparan bounds DOM/nativos hasta 1 DIP.
