# Auditoría de los agentes por tarjeta (2026-09-18)

Base: `main` en `b122ff8` más el trabajo sin publicar de los agentes Browser Use por tarjeta
([ADR 0005](../adr/0005-card-scoped-browser-use-agents.md)). Equipo: Apple M4 Pro, macOS 27.0, Node.js 24.21.0 oficial
(tarball verificado contra `SHASUMS256.txt`), Electron 44.4.1, Python 3.12.9, Browser Use 0.13.10 y CDP Use 1.4.5
instalados desde `requirements.lock` con verificación de hashes.

## Estado de partida

`npm run verify` pasaba (195 unitarias) y las 9 pruebas del protocolo Python también, pero ninguna prueba ejercitaba
la cadena real renderer → main → sidecar → pasarela → página, ni la pasarela contra Browser Use. Las comprobaciones de
esta auditoría se hicieron con sondas Electron, la versión fijada de Browser Use y un modelo OpenAI-compatible falso.

## Hallazgos y correcciones

| ID | Área | Hallazgo y evidencia | Corrección |
|---|---|---|---|
| A-01 | Seguridad | `Page.navigate` por CDP es una navegación iniciada por el navegador: no emite `will-navigate` y una sonda cargó `file:///etc/hosts` en la tarjeta. Un agente manipulado por una página podía leer archivos locales | la pasarela aplica la allowlist de la tarjeta; `BrowserRuntime` detiene en `did-start-navigation` y abandona en `did-navigate` cualquier navegación a otro esquema |
| A-02 | Funcional | Chromium no produce frames para una vista oculta: `Page.captureScreenshot` no respondía (sonda: >6 s; Browser Use espera 15 s por paso) con la tarjeta fuera de pantalla, tapada, minimizada, en zona colapsada o con la ventana oculta | la pasarela captura con `webContents.capturePage({ stayHidden: true })`: 0,04 s en la traza y sin cambio de `visibilityState` |
| A-03 | UX | Los clics del agente llegan como `input-event` mientras el comando está en curso: cada clic seleccionaba y elevaba su tarjeta, robando la selección | los comandos `Input.*` se marcan como sintéticos y el runtime los ignora para la selección |
| A-04 | Funcional | La sesión de Electron nunca recibe el dominio `Target`, así que Browser Use no recibía `targetInfoChanged` y describía al modelo la URL y el título anteriores a cada navegación | la pasarela anuncia `targetCreated` y `targetInfoChanged` de su tarjeta |
| A-05 | Seguridad | Se reenviaban `Page.close` (cerraba la tarjeta), `Page.crash`, `Page.resetNavigationHistory`, `Network.loadNetworkResource` y `Page.bringToFront` | denegados; `bringToFront` no hace nada |
| A-06 | Funcional | `BrowserSession(**opciones)` fallaba siempre en 0.13.10 (`demo_mode` no es argumento de la sesión); solo funcionaba un camino de respaldo | la sesión se construye desde `BrowserProfile` |
| A-07 | UX | Sin pantalla detectable, Browser Use emula 1920×1080 (sonda: `innerWidth` 1920) y reorganiza la página dentro de la tarjeta; además pintaba su animación de carga en tarjetas en blanco | `headless=False`, `no_viewport=True` y sin animación |
| A-08 | Build/CI | `forge.config.cjs` elegía el sidecar por la arquitectura del equipo, no la del paquete, y `npm run package` (también en CI) fallaba sin sidecar con un error opaco; el CI no construía el sidecar | copia en `packageAfterCopy` con la arquitectura empaquetada y mensaje claro; CI con Python 3.12, `agent:test`, `agent:build`, `agent:compat`, verificación del sidecar dentro del `.app` y la E2E del agente obligatoria |
| A-09 | Rendimiento | El canvas medía con `getBoundingClientRect` el panel de **todas** las tarjetas y recreaba un `ResizeObserver` en cada frame de pan, arrastre o zoom; además aplicaba primero los límites del frame anterior (doble lote y desalineación de un frame) y usaba esos límites para saltarse el umbral del zoom semántico | el reparto página/chat se calcula con la geometría existente (`agentSplitPaneWidth`) solo para tarjetas con el panel abierto |
| A-10 | Estado | Tras cambiar de perfil, la tarjeta recibe un agente nuevo con secuencia 0; el renderer lo descartaba por "antiguo" y seguía mostrando la conversación anterior | el estado se sigue por `agentId` y secuencia (`useAgents`, `agent-sync.ts`) |
| A-11 | Lógica | El resumen de la conversación se pasaba como "progreso interrumpido" a cualquier tarea nueva y cada interrupción lo ampliaba; una instrucción de seguimiento no recibía el contexto de la anterior | progreso por tarea y, como contexto, los últimos turnos de la conversación de la tarjeta |
| A-12 | Robustez | Un error del almacén de agentes (por ejemplo, `agents` como archivo) impedía arrancar OmniBrowser | los agentes quedan desactivados con un aviso y el workspace arranca |
| A-13 | Rendimiento | Se creaba y escribía con `fsync` un registro por tarjeta al arrancar y al crear cada vista | registros creados al usarse; abrir el panel no escribe nada |
| A-14 | Ciclo de vida | Durante el cierre, interrumpir una tarea liberaba capacidad y podía arrancar otra en cola | la cola no arranca nada mientras la app se cierra y rechaza instrucciones nuevas |
| A-15 | Protocolo | El worker escuchaba `exit`, que puede llegar antes de leer la última línea (resultado) | escucha `close`; los errores previos al arranque (p. ej. el stub de E2E) llegan con su código |
| A-16 | UX | Errores del sidecar y resúmenes en inglés; un error no fatal (pausa tardía) terminaba la tarea | mensajes en español por código, tipo de excepción sin contenido de la página, errores no fatales como aviso |
| A-17 | Seguridad | Probar o guardar el proveedor sin clave reutilizaba la clave guardada con cualquier URL base nueva | la clave solo se envía a su origen; otro endpoint exige escribirla (main y diálogo) |
| A-18 | UX | La prueba del proveedor fallaba con modelos de razonamiento (`temperature` y 64 tokens) y no explicaba errores de red o del proveedor | petición sin parámetros de muestreo, 1024 tokens, mensajes de red, tiempo agotado y detalle del proveedor con la clave redactada, mostrados en el diálogo |
| A-19 | UX | Historial del chat con toda la actividad debajo de todos los mensajes, autodesplazamiento forzado, Enter enviaba durante una composición IME, límite de 8000 caracteres distinto del de main, Space dentro del chat activaba el pan del canvas | historial intercalado, seguimiento solo cerca del final, IME respetado, límite compartido, Space ignorado al escribir |
| A-20 | UX | Una tarjeta bloqueada o fijada se "ampliaba" solo en el renderer (main rechaza el cambio) y el chat quedaba recortado | no se amplía; la columna del chat siempre cabe y la vista nativa se oculta si la página queda por debajo de 160 unidades |
| A-21 | Otros | Cola sin límite (se perdían instrucciones antiguas al compactar), Detener sin respuesta en el chat, mensajes de validación genéricos para campos de agentes, la confirmación de cambio de perfil no avisaba de que se borra la conversación | cola de 20 con error explícito, respuesta de cancelación, mensajes por campo y aviso en la confirmación |
| A-22 | Higiene | `src/shared/urls.ts` contenía bytes de control literales (NUL, US, DEL) en una expresión regular, por lo que `grep` y git lo trataban como binario; faltaban reglas `.gitignore` para `dist`, `build`, entornos virtuales y `__pycache__` del sidecar | escapes `\u0000-\u001f\u007f` equivalentes y reglas añadidas |

## Verificación

| Comprobación | Resultado |
|---|---|
| `npm run verify` | typecheck y lint sin avisos; 227 unitarias en 30 archivos |
| `npm run agent:test` | 12 pruebas |
| `npm run agent:build` (Python 3.12.9, arm64) | sidecar congelado en ~50 s; `--self-check` con 0.13.10/1.4.5 |
| `npm run agent:compat` | pasa: solo su target; capturas visible y oculta (0,04 s) sin cambio de visibilidad; clic, escritura y navegación con URL y título actualizados; pestañas, target vecino, `file:`, cookies y `Page.close` denegados; 0 selecciones por entrada del agente; debugger liberado |
| `npm run test:poc` | 5 POC pasan (canvas sin captura compuesta por falta de permiso de grabación de pantalla, como en auditorías anteriores) |
| `npm run test:e2e:only` | 35 escenarios, incluida la tarea completa del agente con el sidecar congelado y un modelo local: el clic cambia la página, la selección no cambia y ni la clave ni la capacidad CDP quedan en `userData` |
| `npm run package` con el sidecar real | `Contents/Resources/agent-host` arm64 fuera de `app.asar` (102 MB); `codesign --verify --deep --strict` y `--self-check` desde el bundle |

## Seguimiento: proveedor OpenAI-compatible real

El mismo día se probó la integración con un proveedor real: un router OpenAI-compatible con un modelo de razonamiento
con visión, usando credenciales temporales facilitadas para la prueba. Las credenciales no se guardaron en el
repositorio ni en la configuración de la aplicación del equipo; las pruebas usaron perfiles temporales.

| ID | Área | Hallazgo y evidencia | Corrección |
|---|---|---|---|
| A-23 | Build | La aplicación que se abría (`out/OmniBrowser-darwin-arm64`, generada a las 00:51) era un paquete de `npm run package:test`: código anterior a esta auditoría y stub de E2E en lugar del sidecar. Su prueba del proveedor pedía 64 tokens con `temperature: 0` y el modelo los gastaba razonando (`finish_reason: length`, contenido vacío), así que el diálogo decía que el proveedor ignoraba la salida estructurada; ninguna tarea podía ejecutarse | `package:test` escribe en `out/test-stub/`; `out/` se regeneró con `npm run package` y el sidecar real |
| A-24 | Proveedor | Con 1024 tokens la prueba pasaba con este modelo (229 tokens de razonamiento), pero sin margen para modelos que razonan más, y un truncado o una respuesta solo con razonamiento se describían como "JSON ignorado" | la prueba usa el límite de Browser Use por paso (4096 tokens), espera hasta 60 s y explica ambos casos |
| A-25 | Funcional | Tras una navegación entre sitios, `capturePage` falló con `UnknownVizError` y Browser Use hizo ese paso sin captura. Una sonda mostró uno o dos frames fallidos de unos 40 ms alrededor del commit, también con la tarjeta oculta | la pasarela reintenta la captura hasta 5 veces cada 100 ms |
| A-26 | Desarrollo | Sin `agent:build`, `npm start` lanzaba `agent_host.py` con el `python3` del sistema (3.14, sin Browser Use) y el chat solo decía "El agente no pudo iniciarse" | se usa el entorno `.venv-<arch>` de `agent:build` o el chat pide construirlo; el sidecar informa `runtime-unavailable` si no puede cargar Browser Use |
| A-27 | UX | El modelo respondió en inglés a una instrucción en español | el sidecar pide la respuesta final en el idioma de la instrucción |

| Comprobación con el proveedor real (arm64) | Resultado |
|---|---|
| Prueba del proveedor por IPC y desde el diálogo, con la clave guardada y la app reiniciada | "Conexión y respuesta estructurada verificadas." en 6–8 s |
| Tarea desde el chat de una tarjeta (bundle de producción, sidecar congelado, `--use-mock-keychain`) | escribir, clic y finalizar en 32 s; la página muestra el saludo pedido, la selección no cambia y la clave no aparece en claro en `userData` |
| Tarea en una página real (Wikipedia en español) | navega y responde el año pedido en 28–37 s, unos 12 s por llamada al modelo (Browser Use espera 75 s) |
| Sidecar congelado con la tarjeta oculta | tarea completada en 41 s |
| `out/OmniBrowser-darwin-arm64` regenerado | arranca con un perfil temporal, cierra guardando con `SIGTERM` y su sidecar pasa `--self-check` |

## Seguimiento: llavero de macOS

Al guardar el proveedor en la aplicación regenerada, macOS pidió la contraseña del Mac; tras denegarla, el diálogo
mostró "El cifrado seguro del sistema no está disponible; la clave del proveedor no se guardó." y el agente quedó
inutilizable. Cada build local con firma ad hoc es una identidad nueva para la entrada «OmniBrowser Safe Storage» del
llavero, así que el aviso reaparece tras cada reconstrucción.

| ID | Área | Hallazgo y evidencia | Corrección |
|---|---|---|---|
| A-28 | UX | Guardar exigía el llavero: una denegación impedía usar el agente, el aviso de macOS llegaba sin explicación previa y no había alternativa | «Recordar la clave en este Mac» (activado por defecto) explica el aviso antes de guardar; desmarcado, la clave vive solo en memoria de main y no se toca el llavero; si macOS deniega, la clave se usa en la sesión y el diálogo explica cómo guardarla (reiniciar y «Permitir siempre»). La URL y el modelo se guardan sin la clave |
| A-29 | Robustez | `ProviderStore` y `AgentManager` descifraban la clave al arrancar: macOS pedía la contraseña en cada inicio de un build nuevo aunque no se usara el agente, y una denegación podía apartar `agent-provider.json` como corrupto | la clave se descifra solo cuando una tarea o una prueba la necesita; una denegación no se trata como corrupción |
| A-30 | UX | Con la clave guardada pero ilegible en la sesión, cada tarea fallaba con "No se pudo iniciar el agente: No se pudo descifrar…" y el mensaje de arranque decía "no se guardó" aunque sí estaba guardada | el primer fallo explica qué hacer (escribir la clave de nuevo o reiniciar y permitir) y las tarjetas vuelven a pedir un proveedor en lugar de fallar una tarea tras otra |

Verificación: pruebas unitarias con un llavero que deniega y otro que no debe tocarse (arranque sin accesos, tarea con
mensaje explicativo, reintroducir la clave, clave solo de sesión que no toca el llavero ni el disco y reinicio con URL y
modelo conservados), pruebas del diálogo y una E2E con el sidecar congelado en la que la clave de sesión llega al modelo,
no aparece en ningún archivo de `userData` y, tras reiniciar, el diálogo conserva URL y modelo y pide solo la clave. La
denegación real del aviso de macOS no se automatizó: es un diálogo de seguridad del sistema.

## Límites que no se pudieron cerrar aquí

- El CI modificado no se ha ejecutado en GitHub: la rama no se ha publicado. El runner x64 construirá su propio sidecar;
  el artefacto x64 no se probó localmente (sin Rosetta).
- Las tareas con un modelo real se verificaron con un solo proveedor y modelo (seguimiento anterior); otros proveedores
  pueden diferir en salida estructurada o visión. La E2E automática sigue usando un modelo falso que responde con el
  esquema de salida de Browser Use 0.13.10.
- La copia de `out/` dentro de iCloud Drive no pasa `codesign --verify --strict` porque el File Provider añade atributos
  Finder; el mismo paquete verificado fuera de iCloud es válido y la app arranca.
- La firma Developer ID y la notarización del sidecar siguen pendientes de las credenciales del mantenedor
  ([checklist](../release-checklist.md)); la firma ad hoc local se verificó.
- Las regiones de captura fuera del viewport y las capturas de página completa siguen el camino CDP, que no responde con
  la tarjeta oculta. Browser Use 0.13.10 no las usa en su bucle (su acción `screenshot` está desactivada).
