# ADR 0002: Persistencia atómica en disco y recuperación ante corrupción

- Estado: aceptado para el MVP
- Fecha: 2026-09-17
- Decisores: mantenedores de OmniBrowser

## Contexto

OmniBrowser opera como un navegador de canvas espacial local sin base de datos pesada ni sincronización cloud. El estado completo del espacio de trabajo (perfiles persistentes, tarjetas, historial de URLs y títulos, z-order, geometría de canvas, zonas, stacks, pins y preferencias) debe persistirse de forma duradera y confiable en un único archivo (`workspace.json`).

Los desafíos críticos identificados incluyen:
1. **Riesgo de truncamiento o corrupción:** Apagados forzados, caídas del sistema o cierres repentinos durante una escritura en disco pueden dejar el archivo JSON a medio escribir o corrupto.
2. **Degradación de datos por concurrencia:** Múltiples actualizaciones rápidas (pan, resize, cargas continuas de URLs) pueden saturar el disco o crear condiciones de carrera si no se agrupan adecuadamente.
3. **Peligro de pérdida de datos preexistentes:** Sobrescribir un archivo no legible o proveniente de una versión futura más reciente borraría irreversiblemente el trabajo del usuario.
4. **Vulnerabilidades de enlaces simbólicos (symlinks):** Un atacante local o configuración defectuosa podría vincular `workspace.json` a un archivo crítico del sistema mediante symlinks o path traversal.
5. **Aislamiento estricto de perfiles Private:** El estado efímero y privado jamás debe filtrarse a disco.

## Decisión

Implementar un subsistema de persistencia en capas compuesto por `WorkspaceStore`, `SaveScheduler` y `workspace-migrations.ts`, bajo los siguientes principios:

### 1. Escritura atómica y permisos restringidos
- La escritura de `workspace.json` y `workspace.backup.json` utiliza un archivo temporal exclusivo creado con máscara y permisos `0600` (`-rw-------`).
- Se invoca `fsync` en el descriptor del archivo temporal antes de cerrarlo para asegurar que los datos residan en medios físicos no volátiles.
- El archivo temporal se mueve a la ruta de destino mediante `fs.rename` atómico POSIX, seguido de sincronización best-effort del directorio padre (`fs.open` + `fsync` en el directorio).
- Cualquier archivo temporal huérfano (`workspace.*.tmp`) dejado por caídas previas se purga automáticamente durante el arranque.

### 2. Estrategia de backups y memoria
- `workspace.backup.json` almacena el último snapshot válido escrito o cargado. **Crucialmente, este backup se genera desde la representación validada en memoria**, nunca copiando a ciegas bytes corruptos del archivo principal de disco.
- Se preserva `workspace.v1-backup.json` como copia única e inmutable del estado V1 antes de ejecutar la primera migración y escritura en formato V2.

### 3. Preservación estricta ante corrupción y esquemas futuros
- Si `workspace.json` o su backup están corruptos, contienen sintaxis JSON inválida o violan los esquemas Zod, **jamás se sobrescriben**.
- El archivo dañado se renombra a `workspace.corrupt-<timestamp>-<uuid>.json` (o `workspace.backup.corrupt-...`) y se informa al usuario mediante `ShellNotices` con el nombre exacto del archivo preservado.
- Si el archivo contiene una versión de esquema mayor que la soportada (versiones futuras), se preserva como `workspace.future-v<N>-<timestamp>-<uuid>.json` sin destruirlo.

### 4. Seguridad de acceso al sistema de archivos
- La lectura valida el archivo con `fs.lstat` y flags `O_NOFOLLOW`, rechazando enlaces simbólicos, named pipes, directorios o archivos no regulares.
- Se impone un límite estricto de 10 MiB para `workspace.json`. Si el archivo supera este umbral, se rechaza o se recortan de forma defensiva las entradas de historial más alejadas de la posición activa de cada tarjeta.

### 5. Planificación y coalescencia (`SaveScheduler`)
- Los cambios estructurales (crear tarjeta, cerrar, mover, cambiar perfil) se programan con un debounce de 450 ms.
- Se garantiza una ventana máxima de 2000 ms (2 s) desde el primer cambio pendiente: la actividad continua de eventos no puede posponer indefinidamente el guardado en disco (*starvation prevention*).
- Cambios de bajo valor (títulos de páginas, dimensiones de ventana) utilizan un retardo de 5 s que nunca posterga una escritura estructural ya programada.
- Errores de guardado se capturan con retroceso exponencial (hasta 30 s) e informan visualmente en la UI del shell sin generar rechazos no controlados.

### 6. Filtrado de privacidad
- `WorkspaceModel.toPersistentFile()` purga sistemáticamente todos los perfiles Private, sus tarjetas, URLs, títulos, historial, zonas y pins antes de entregar la carga a `WorkspaceStore`.
- No se persisten estados DOM transitorios (`pageState`, campos de formulario, posición de scroll ni favicons remotos).

## Consecuencias

### Positivas
- Garantía contra corrupción ante cortes de corriente o cierres inesperados.
- Preservación forense y diagnóstica de archivos dañados sin pérdida total de configuración.
- Rendimiento fluido: el disco solo recibe ráfagas consolidadas y las escrituras idénticas en memoria se descartan inmediatamente.
- Ninguna filtración de datos privados ni exposición a symlinks maliciosos.

### Costes y limitaciones
- Los datos muy recientes (<450 ms) pueden perderse si la máquina sufre un kernel panic inmediato antes del vaciado.
- Los archivos corruptos preservados acumulan espacio en `userData` hasta que el usuario decida eliminarlos.

## Decisiones arquitectónicas complementarias

- [ADR 0001: Motor Electron, WebContentsView y particiones por perfil](0001-engine-and-profile-model.md)
- [ADR 0003: Composición nativa WebContentsView en ventana única y gestión de oclusores](0003-single-window-canvas-layout-and-native-occlusion.md)
- [Arquitectura general del MVP](../architecture.md)
