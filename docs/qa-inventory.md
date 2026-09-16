# QA inventory del MVP

Este inventario vincula cada afirmación visible del MVP con una comprobación funcional y una evidencia visual. El almacenamiento profundo (IndexedDB, Cache Storage, service workers y caché HTTP) se cubre en los POC deterministas; la suite E2E cubre el flujo completo de la aplicación.

| Área | Estado o control | Comprobación funcional | Evidencia visual |
|---|---|---|---|
| Arranque | shell, perfil Personal, perfil Temporal y primera tarjeta | bootstrap tipado; una tarjeta inicial | captura principal, 1440×900 |
| Perfiles | crear persistente y temporal; seleccionar | Trabajo persiste; Descartable desaparece al reiniciar | rail en captura principal |
| Sesión compartida | dos tarjetas Trabajo | cookie durable, cookie de sesión y localStorage visibles en ambas | títulos/etiquetas de tarjetas |
| Aislamiento | tarjeta Personal frente a Trabajo | Personal no lee datos de Trabajo; reasignar recrea la vista | encabezados con perfil |
| Navegación | URL, atrás, adelante y recargar | fixture local y contador de solicitudes | toolbar en captura principal |
| Seguridad URL | `javascript:` | rechazo y aviso visible | toast revisado durante E2E |
| Canvas | mover, redimensionar y pan | cambio persistido en geometría/cámara | captura principal postinteracción |
| Zoom | botones y modo semántico <50% | tres tarjetas semánticas; seleccionar vuelve a 72% | `implementation-semantic-zoom-arm64.png` |
| Suspensión | suspender y reactivar | destrucción/recreación y estado awake | placeholder de reposo revisado durante E2E |
| Persistencia | guardar, cerrar y relanzar | perfiles/tarjetas durables vuelven; cookie de sesión no | captura principal y estado restaurado |
| Ventana mínima | 1040×680 | regiones esenciales dentro del viewport, sin scroll | `implementation-minimum-window-arm64.png` |
| Vista densa | tres navegadores superpuestos | z-order/foco y minimapa | `implementation-primary-arm64.png` |

Escenarios exploratorios incluidos: URL con esquema bloqueado; reasignación de perfil ida/vuelta; suspensión seguida de reactivación; reinicio con estado temporal y durable mezclados; reducción a ventana mínima después de restaurar.
