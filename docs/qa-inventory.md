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
| Modos | full screen, minimize y pin al viewport | full screen/Escape —también con foco dentro del `WebContents`— y minimize restauran `worldRect`; el pin no se mueve con la cámara y unpin vuelve al canvas | `runtime-regressions.spec.ts` |
| Organización | zonas, colapso y stacks | las zonas ocultan/recuperan vistas; un stack enseña sólo el miembro superior y unstack separa miembros | `runtime-regressions.spec.ts` |
| Selección múltiple | Shift+click, marquesina, movimiento/escala y acciones masivas | movimiento y lock atómicos; snapshot merge conserva todos los rectángulos activos | `runtime-regressions.spec.ts`, unitarias |
| Sidebar | árbol de perfiles/zonas/stacks, fijados, contadores, búsqueda, estados, cierre, ordenar y localizar | drag reorder, pin, búsqueda local, zoom-to-browser offscreen y cierre sincronizados | `runtime-regressions.spec.ts` |
| Zoom | botones y modo semántico <50% | tres tarjetas semánticas; seleccionar vuelve a 72% | `implementation-semantic-zoom-arm64.png` |
| Suspensión | suspender y reactivar | destrucción/recreación y estado awake | placeholder de reposo revisado durante E2E |
| Persistencia | guardar, cerrar y relanzar | perfiles/tarjetas durables vuelven; cookie de sesión no | captura principal y estado restaurado |
| Ventana mínima | 1040×680 | regiones esenciales dentro del viewport, sin scroll | `implementation-minimum-window-arm64.png` |
| Vista densa | tres navegadores superpuestos | z-order/foco y minimapa | `implementation-primary-arm64.png` |
| Alineación nativa | pan por arrastre y rueda, arrastre, resize, teclado | error ≤ 1 DIP entre `WebContentsView` y content slot | `runtime-regressions.spec.ts` |
| Oclusión | tarjeta superior, minimapa, aviso visible | ninguna superficie visible cubre controles React | `runtime-regressions.spec.ts` |
| Resiliencia | arranque sin red, crash del renderer, URL remota > 4096, título que cambia sin parar | el shell arranca, la tarjeta se recupera y el workspace se guarda | `runtime-regressions.spec.ts` |
| Lifecycle | wake/sleep/close repetidos, popups tras suspender/cerrar el opener, quit, segunda instancia | sin vistas duplicadas ni tarjetas perdidas; el proceso termina y conserva el estado | `runtime-regressions.spec.ts` |
| Seguridad remota | bridge, Node.js, `omnibrowser://`, CORS, permisos, `<webview>`, CSP del shell, bucle de `mailto:` | todo bloqueado o denegado; un solo diálogo externo | `runtime-regressions.spec.ts` |
| Favicons | caché local opaca | esquema/redirecciones/allowlist raster-ICO/tamaño limitados; SVG rechazado y CSP sin ampliar | `favicon-cache.test.ts` |
| Descargas | sólo browser registrado y diálogo del sistema | no `setSavePath`, origen desconocido cancelado, ruta ausente de snapshots y cancelación al cerrar | `security-policy.test.ts`; diálogo manual |
| Migración | V1→V2 y recuperación | defaults, filtrado legacy Temporal y copia `workspace.v1-backup.json` 0600 que no se sobrescribe | `workspace-store.test.ts` |
| Rendimiento organizativo | árbol, búsqueda y snap con 500 browsers | derivación lineal funcional; observaciones reproducibles sin gate de tiempo | `sidebar-tree.test.ts`, `npm run test:perf` |
| Entradas inválidas | búsqueda implícita, vacío, > 4096, `javascript:`, `file:` | mensajes en español sin excepciones en main | `runtime-regressions.spec.ts` |

Escenarios exploratorios incluidos: URL con esquema bloqueado; reasignación de perfil ida/vuelta; suspensión seguida de reactivación; reinicio con estado Private y durable mezclados; reducción a ventana mínima después de restaurar.

## Compuertas manuales pendientes

- Trackpad físico Apple Silicon e Intel: dos dedos sobre browser activo deben conservar scroll de página; sobre browser inactivo deberían panear el canvas sólo si Electron permite cancelar el evento antes del contenido.
- Historial horizontal: permanece sin toggle público hasta demostrar inicio en borde, predominio horizontal, un disparo por gesto y ausencia de scroll simultáneo.
- Descarga: el diálogo nativo y la permanencia del archivo aceptado se validan manualmente; CI sólo comprueba asociación, progreso, cancelación y ausencia de rutas.

El Browser integrado de Codex sirve para páginas web, pero no puede inspeccionar la composición `WebContentsView` de una aplicación Electron. Para estas comprobaciones se usa Playwright Electron contra el bundle de producción y se comparan bounds DOM/nativos hasta 1 DIP.
