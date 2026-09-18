# ADR 0005: agentes Browser Use aislados por tarjeta

- Estado: Aceptado
- Fecha: 2026-09-18

## Contexto

OmniBrowser ya modela cada superficie navegable como un `BrowserRecord.id` UUID y mantiene exactamente un
`WebContentsView` vivo por tarjeta en `BrowserRuntime`. Los perfiles son otra frontera: dos tarjetas del mismo perfil
comparten cookies y almacenamiento de Chromium, pero no comparten identidad, navegación ni ciclo de vida de vista.

Browser Use puede conectarse a un browser existente mediante CDP. Abrir `--remote-debugging-port` sobre Electron,
sin embargo, publicaría el catálogo global de targets y permitiría que un proceso destinado a una tarjeta se adjuntase
a otra tarjeta, al shell o a un popup. Ejecutar Browser Use Cloud, su CLI o un Chrome separado perdería además la
sesión y la superficie que la persona ve en OmniBrowser.

## Decisión

La identidad y propiedad se encadenan así:

```text
BrowserRecord.id (browserId)
  -> AgentRecord.agentId
    -> AgentRecord.chatSessionId
      -> ActiveAgentRun(browserSession: contentsId + runtimeEpoch + targetId)
```

`AgentManager`, en el proceso principal, es el único orquestador. Mantiene una cola serial por `browserId`, como
máximo una ejecución por tarjeta y cuatro ejecuciones globales. El renderer solo puede invocar operaciones cerradas
con un `browserId`; nunca recibe `WebContents`, target IDs, URLs CDP, tokens o claves del proveedor.

Para cada ejecución, `ScopedCdpGateway` adjunta `webContents.debugger` al `WebContents` concreto y crea en loopback
una URL de capacidad aleatoria y efímera. La pasarela presenta un browser virtual de un único target, virtualiza la
parte mínima de `Target.*`, reenvía solo dominios CDP auditados y deniega enumeración global, creación/cierre de tabs,
cookies, descargas y controles globales. Todo mensaje del worker se valida contra `browserId`, `agentId`, `taskId`,
`runId`, `runtimeEpoch` y secuencia; un mensaje tardío de una vista recreada se descarta.

Browser Use vive en un sidecar Python propio, fijado por versión y empaquetado con PyInstaller `onedir`. Main le envía
por stdin JSONL la instrucción, la URL de capacidad y el proveedor. El worker no registra shell, filesystem, MCP ni
herramientas para cambiar de tarjeta; desactiva Cloud, telemetría, trazas, HAR, vídeo y persistencia de capturas. El
sidecar se incluye fuera de `app.asar`, se firma antes de volver a sellar la aplicación y no depende del Python del
sistema instalado.

`AgentStore` guarda cada agente persistente en `userData/agents/<browserId>.json`, con escritura atómica `0600`,
validación, recuperación de corrupción, compactación y límites. Los agentes Private permanecen solo en memoria. La
clave OpenAI-compatible se cifra por separado con `safeStorage` y nunca vuelve al renderer; si la persona no quiere
recordarla o macOS deniega el llavero, queda solo en memoria de main durante la sesión y el archivo guarda URL y
modelo. No se guardan cookies, DOM, capturas, tokens CDP, claves, contenido de campos sensibles, razonamiento interno ni
estado Python.

Cerrar o duplicar una tarjeta, adoptar un popup y cambiar de perfil no transfieren un agente. Suspender, cambiar
perfil, destruir un target, la caída de su página o cerrar la aplicación revoca primero CDP y detiene el worker. Una
ejecución interrumpida se restaura como `Paused`; reanudarla crea un worker y una sesión CDP nuevos, y el worker recibe
los pasos que la tarea ya había completado. Compartir perfil conserva la semántica web existente, pero nunca concede
control cruzado.

### Decisiones de implementación (auditoría 2026-09-18)

La traza de compatibilidad con Browser Use 0.13.10 (`npm run agent:compat`) y sondas empíricas con Electron 44.4.1
fijaron estas reglas de la pasarela y del runtime:

- **Capturas sin frames visibles.** Chromium no produce frames para una vista oculta: `Page.captureScreenshot` no
  responde mientras la tarjeta está fuera de pantalla, tapada, minimizada, en una zona colapsada o con la ventana oculta,
  y Browser Use captura en cada paso (15 s de espera). La pasarela lo resuelve con
  `webContents.capturePage(rect, { stayHidden: true })`: la página no observa cambio de visibilidad. Durante el cambio
  de superficie de una navegación, `capturePage` falla uno o dos frames (`UnknownVizError`), que la pasarela reintenta.
  Las capturas de página completa o de regiones fuera del viewport siguen el camino CDP.
- **Proveedores con razonamiento.** La prueba del proveedor usa el mismo límite de salida que Browser Use en cada paso
  (4096 tokens) y no envía parámetros de muestreo; un modelo de razonamiento que agota el límite o devuelve solo su
  razonamiento se rechaza con un motivo explícito, porque Browser Use fallaría igual en cada paso.
- **Navegación.** `Page.navigate` es una navegación iniciada por el navegador y no emite `will-navigate`: sin control
  cargaba `file:///etc/hosts`. La pasarela aplica la allowlist de la tarjeta y `BrowserRuntime` detiene o abandona
  cualquier navegación de ese tipo hacia otro esquema.
- **Entrada sintética.** Electron emite `input-event` para la entrada CDP mientras el comando está en curso. La pasarela
  delimita los comandos `Input.*` y el runtime no selecciona ni eleva una tarjeta por un clic del agente.
- **Metadatos del target.** Como la sesión de Electron nunca recibe el dominio `Target`, la pasarela anuncia
  `Target.targetCreated` y `Target.targetInfoChanged` de su propia tarjeta; sin ellos, Browser Use describía al modelo
  la URL y el título anteriores a cada navegación.
- **Superficie denegada adicional.** `Page.close`, `Page.crash`, `Page.resetNavigationHistory`,
  `Network.loadNetworkResource` y la interceptación del selector de archivos; `Page.bringToFront` no hace nada.
- **Sidecar.** El perfil de Browser Use fija `headless=False` y `no_viewport=True` (si no detecta pantalla emularía
  1920×1080 y reorganizaría la página dentro de la tarjeta), se construye con `BrowserProfile` y no pinta su animación de
  carga en una tarjeta en blanco. Forge copia el sidecar de la arquitectura que se empaqueta, no la del equipo.
- **Proveedor.** La clave guardada solo se envía al origen para el que se guardó; otro endpoint exige escribirla.
- **Llavero.** Leer el llavero al arrancar hacía que macOS pidiera la contraseña del Mac en cada inicio de un build
  nuevo, y una denegación se trataba como archivo corrupto y apartaba la configuración. La clave se descifra solo cuando
  una tarea o una prueba la necesita; una denegación al guardar deja la clave en memoria para la sesión y el diálogo lo
  explica; «Recordar la clave en este Mac» permite no usar el llavero en absoluto.

## Consecuencias

- `BrowserRuntime` sigue siendo el único propietario de las vistas; el canvas, el workspace y las sesiones no se
  reemplazan.
- La pasarela debe mantenerse compatible con la versión fijada de Browser Use. Cada actualización exige ejecutar
  `npm run agent:compat` (también en CI) y revisar explícitamente el allowlist.
- El panel de chat puede cerrarse sin detener el trabajo; el estado se conserva por tarjeta y se recupera por secuencia.
- La primera versión controla una sola página por tarjeta. Un `window.open` crea otra tarjeta y otro agente; no existe
  una herramienta para saltar entre tarjetas.
- Una tarjeta comparte credenciales web con otras del mismo perfil por diseño. Para aislar credenciales se usan
  perfiles diferentes.

## Alternativas rechazadas

- Puerto CDP global de Electron: rompe la frontera de capacidad por tarjeta.
- Browser Use CLI/MCP: añade transporte, pero no impone por sí solo aislamiento de targets.
- Browser Use Cloud o Chrome separado: no controla la sesión visible existente.
- Agente CDP nativo TypeScript: duplicaría el planificador, herramientas y mantenimiento de Browser Use.

