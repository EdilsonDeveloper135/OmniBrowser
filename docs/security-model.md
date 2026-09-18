# Modelo de seguridad del MVP

## Activos

- cookies y tokens de sesión de cada perfil;
- IndexedDB, DOM storage, Cache Storage, service workers y caché HTTP;
- URLs/títulos del workspace y geometría de la ventana;
- capacidad de abrir aplicaciones/protocolos externos;
- filesystem y APIs Node del proceso principal;
- la clave del proveedor de IA de los agentes y sus conversaciones;
- el control de cada tarjeta por su agente (una capacidad CDP efímera por ejecución).

## Límites de confianza

1. **Contenido remoto no confiable → Chromium sandbox.** Cada página puede ser hostil.
2. **Renderer del shell → preload.** El shell forma parte del paquete, pero sigue sin Node integration.
3. **Preload → IPC main.** Solo métodos nominados, argumentos Zod y sender exacto.
4. **Main → sistema operativo.** Archivos locales, Keychain/cookies cifradas, diálogo y `shell.openExternal`.
5. **Perfil → perfil.** La partición Chromium es el límite de aislamiento de sesión.
6. **Agente → tarjeta.** El sidecar Browser Use y el modelo remoto son tan poco confiables como el contenido de la
   página: solo reciben una capacidad CDP de loopback limitada a una tarjeta, filtrada por `ScopedCdpGateway`.

## Controles

| Riesgo | Control del MVP |
|---|---|
| RCE desde una web | `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, sin preload remoto; `<webview>` inerte y guardia global `web-contents-created` que deniega `window.open` y `will-attach-webview` por defecto |
| acceso IPC remoto | bridge solo en shell; validación de `webContents`, frame principal y payload; resultados serializables sin objetos Electron ni stacks |
| navegación a código/local | allowlist `https:`, `http:`, `about:blank`; bloqueo de `javascript:`, `data:`, `file:` y esquemas desconocidos |
| popup privilegiado | handler explícito; mismas preferencias/sesión; adopción como tarjeta |
| escalada por permisos | permission check/request y device handlers deny-by-default; se conserva la lista por defecto de clases USB protegidas |
| descarga no atribuible o silenciosa | sólo se acepta `will-download` de un `webContents.id` registrado; diálogo nativo sin `setSavePath`; ruta y nombre nunca expuestos al shell ni persistidos; cancelación y borrado del parcial al cerrar el browser, reasignarlo o salir |
| protocolos externos | allowlist + URL parseada + confirmación nativa; un solo diálogo a la vez y 5 s de enfriamiento por página, para que un bucle de `mailto:` no bloquee el workspace |
| diálogos JavaScript en bucle | `safeDialogs` permite al usuario impedir más diálogos de una página |
| bloqueo o solapamiento por prompts | se prohíbe `window.prompt()` en el shell; los diálogos de entrada usan `PromptModal` (`.native-occluder` con `data-occluder-type="prompt-modal"`), garantizando flujo asíncrono, aislamiento y ocultamiento de vistas nativas subyacentes |
| persistencia corrupta/inyectada | límite de tamaño aplicado también al escribir, JSON/Zod, migraciones explícitas, `lstat`/`O_NOFOLLOW` sin seguir symlinks, escritura `0600` temporal+fsync+rename de primario y backup, preservación sin sobrescritura de archivos ilegibles o de esquemas futuros |
| URLs remotas que rompen el guardado | captura saneada: sin esquemas bloqueados, URLs ≤ 4096 caracteres, títulos ≤ 512, índice activo reasignado |
| dos procesos sobre el mismo perfil | bloqueo de instancia única; `userData` de desarrollo separado del paquete |
| cruce de perfiles | una partición determinista por UUID; nunca copia manual de storage |
| manipulación de runtime Electron | fuses: no RunAsNode/NODE_OPTIONS/CLI inspector, ASAR integrity y only-load-ASAR |
| secretos en historial | solo URL/título; nunca `pageState`; límite de 500 entradas |
| favicon remoto hostil | sólo URL HTTP(S) emitida por el WebContents; fetch con su Session, cinco redirecciones máximas, allowlist raster/ICO (SVG rechazado) y 256 KiB; clave opaca local, caché en memoria y CSP sin hosts remotos |
| fuga Private al workspace | proyección persistente filtra perfil, browsers, URLs, títulos, historial, zonas, stacks, orden y pins Private; tests inspeccionan el JSON resultante y una E2E busca en todo `userData` (UTF-8 y UTF-16LE), tras salir y tras reiniciar, el token de cookie, `localStorage`, `sessionStorage`, IndexedDB, título y URL de una página Private y el nombre de sus descargas |
| agente que salta a otra tarjeta, al shell o a más pestañas | una pasarela por ejecución con URL de capacidad aleatoria en `127.0.0.1`, un único target virtual, `Target.*` virtualizado, targets ajenos, `Target.createTarget/closeTarget` y dominios no auditados denegados; eventos del worker validados contra browser, agente, tarea, ejecución, epoch y secuencia (`npm run agent:compat` con dos tarjetas) |
| agente que lee credenciales o archivos locales | se deniegan cookies (`Network.*Cookie*`, `Storage.*`), `Network.loadNetworkResource`, `DOM.setFileInputFiles`, descargas e impresión; `Page.navigate` solo acepta `https:`, `http:` y `about:blank`, y el runtime detiene o abandona una navegación iniciada por el navegador hacia otro esquema |
| agente que altera la tarjeta o el workspace | se deniegan `Page.close`, `Page.crash` y el borrado del historial; `Page.bringToFront` no hace nada; la entrada sintética no selecciona ni eleva tarjetas; el sidecar no emula viewport ni pinta sobre una página en blanco |
| fuga de la clave del proveedor o de la capacidad CDP | la clave se cifra con `safeStorage` o, si la persona no quiere recordarla o macOS deniega el llavero, queda solo en memoria de main hasta cerrar la app (nunca en claro en disco); nunca vuelve al renderer y solo se envía al origen para el que se guardó; el llavero no se lee al arrancar, solo cuando una tarea o una prueba necesita la clave; clave y URL CDP viajan por stdin, no por argumentos; el sidecar arranca con entorno mínimo y temporal propio `0700`; su stderr solo se registra como huella SHA-256; los registros redactan claves, tokens y URLs de capacidad, y los Private no tocan disco |
| comportamiento de gestos no publicado | el contrato IPC solo acepta `historySwipeEnabled: false` y el modelo normaliza a `false` el valor cargado de disco; ni un shell comprometido ni un `workspace.json` editado activan navegación por gesto |

La CSP del shell bloquea scripts inline, `eval` y recursos de red. En el paquete, `omnibrowser://` la envía además como cabecera con `connect-src 'self'` (sin WebSocket), `frame-ancestors 'none'` y `X-Content-Type-Options: nosniff`; la cabecera se intersecta con la `<meta>`. En desarrollo, la CSP que Forge inyecta por defecto (con `'unsafe-eval'` e inline) se sustituye por la misma política más `ws://localhost:*` para la recarga en vivo. `style-src-attr 'unsafe-inline'` se mantiene únicamente porque el canvas necesita valores geométricos dinámicos en atributos `style`; no habilita JavaScript inline. El servidor de desarrollo de `npm start` escucha solo en `localhost`; el logger de compilación de Forge (puerto 9000) no permite fijar el host y está documentado en [security-audit.md](security-audit.md).

Electron sigue mostrando en ejecuciones no empaquetadas el aviso "Insecure Content-Security-Policy". Las políticas servidas (cabecera y `<meta>`) no contienen `unsafe-eval`; las E2E comprueban el texto de ambas y la aplicación efectiva de `connect-src`.

El resolvedor de `omnibrowser://app` solo acepta el host `app`, rechaza escapes malformados, bytes NUL y traversal codificado, y confina las rutas al directorio del renderer empaquetado.

## Datos en disco

Los perfiles persistentes son deliberadamente durables. En macOS, el fuse `EnableCookieEncryption` permite que Electron use Keychain para cookies cuando el build tiene identidad de firma consistente. Cada build local con firma ad hoc es una identidad nueva para el llavero: la primera vez que usa la entrada «OmniBrowser Safe Storage», macOS pide la contraseña de inicio de sesión del Mac («Permitir siempre» la recuerda para ese build). Una denegación dura hasta reiniciar la app; la clave del proveedor sigue usándose en memoria durante la sesión. El workspace JSON no está cifrado: URLs y títulos son visibles para cualquier proceso con acceso al usuario local.

Un perfil Private evita que OmniBrowser serialice su identidad, browsers, URLs, títulos, historial, zonas, stacks, orden y pins, y usa una partición de memoria. Al cruzar hacia un perfil persistente sólo se recrea la URL actual, no cookies, almacenamiento ni historial. Al cerrar la aplicación se cancelan descargas activas y se limpian almacenamiento y caché de las sesiones Private.

Mientras el diálogo de guardado espera respuesta, Chromium ya escribe la descarga en un temporal oculto (`.<bundle-id>.XXXXXX`) del directorio de descargas por defecto del usuario, también si procede de un perfil Private: Electron solo fija el destino cuando se cierra el diálogo. Salir de la app con el diálogo abierto elimina ese temporal (comprobado); según el código de Chromium, cancelar el diálogo o cerrar el browser también lo eliminan, pendiente de verificación manual. Un cierre forzado o un crash con el diálogo abierto podría dejarlo. Retener los bytes hasta conocer el destino cambiaría el comportamiento de las descargas largas y es una decisión de producto pendiente ([hardening-2026-09](hardening-2026-09.md)).

No se promete borrado antiforense de swap, memoria, DNS, proxies, logs del sistema, artefactos del sitio ni archivos que el usuario haya decidido guardar mediante el diálogo nativo.

## Amenazas fuera de alcance

- atacante con control de la cuenta macOS o del proceso main;
- malware con permisos para leer/instrumentar la aplicación;
- vulnerabilidades 0-day de Chromium/Electron;
- anonimato de red, VPN/Tor o protección contra fingerprinting;
- un gestor de contraseñas;
- extensiones de Chromium;
- política OAuth de terceros;
- contenido y ciclo de vida de un archivo después de que el usuario acepta guardarlo mediante el diálogo del sistema.

## Reglas de cambio

Todo cambio que conceda un permiso, añada un protocolo, expanda el preload, permita descargas, modifique particiones o introduzca navegación local requiere:

1. amenaza y motivo documentados;
2. test negativo que demuestre el límite;
3. revisión del sender IPC y CSP;
4. repetición de POC relevantes;
5. actualización de este documento y de los [registros de decisiones arquitectónicas (ADRs)](adr/) correspondientes si cambia una decisión.

Consulte [SECURITY.md](../SECURITY.md) para reportar una vulnerabilidad.

La evidencia y las limitaciones de las herramientas automáticas están registradas en [la auditoría de dependencias y hardening](security-audit.md). Los fundamentos arquitectónicos de aislamiento y persistencia se detallan en [ADR 0001](adr/0001-engine-and-profile-model.md) y [ADR 0002](adr/0002-atomic-persistence-and-corruption-recovery.md).
