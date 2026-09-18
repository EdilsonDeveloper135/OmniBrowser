# Registros de Decisiones Arquitectónicas (ADRs)

Este directorio documenta las decisiones arquitectónicas fundamentales y duraderas de OmniBrowser. Cada registro describe el contexto, la decisión adoptada, las alternativas evaluadas, las consecuencias y las compuertas técnicas que condicionan su vigencia.

## Índice de decisiones

| ADR | Título | Estado | Fecha | Área clave |
|---|---|---|---|---|
| [ADR 0001](0001-engine-and-profile-model.md) | Motor Electron, WebContentsView y particiones por perfil | Aceptado | 2026-09-16 | Runtime Chromium, sesiones independientes, adopción de popups |
| [ADR 0002](0002-atomic-persistence-and-corruption-recovery.md) | Persistencia atómica en disco y recuperación ante corrupción | Aceptado | 2026-09-17 | `0600` fsync + rename POSIX, backups en memoria, mitigación de corrupción |
| [ADR 0003](0003-single-window-canvas-layout-and-native-occlusion.md) | Composición nativa WebContentsView en ventana única y gestión de oclusores | Aceptado | 2026-09-17 | Shell React único, content slots, oclusores `.native-occluder`, `PromptModal`, `ErrorBoundary` |
| [ADR 0004](0004-gesture-gating-and-wheel-event-handling.md) | Política de compuerta de gestos y gestión de eventos de rueda no cancelables | Aceptado | 2026-09-17 | No cancelabilidad de rueda en Electron 44, prevención de doble scroll, compuerta cerrada |

## Principios de gobernanza arquitectónica

1. **Local-first y privacidad por diseño:** No hay backend, cuentas cloud ni sincronización externa. Los perfiles Private jamás tocan disco de forma persistente.
2. **Separación estricta de privilegios:** El contenido remoto web no confiable vive exclusivamente dentro de vistas nativas `WebContentsView` en sandbox, sin Node.js ni acceso directo a IPC.
3. **Composición determinista:** Las superficies nativas respetan la geometría del shell React mediante oclusión matemática y componentes accesibles (`PromptModal`).
4. **Compuertas empíricas:** Toda decisión técnica que dependa de capacidades del framework subyacente (Electron/Chromium) se valida continuamente mediante pruebas de concepto (POC) ejecutadas en CI.
