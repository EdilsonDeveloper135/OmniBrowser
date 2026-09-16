# Modelo de seguridad del MVP

## Activos

- cookies y tokens de sesión de cada perfil;
- IndexedDB, DOM storage, Cache Storage, service workers y caché HTTP;
- URLs/títulos del workspace y geometría de la ventana;
- capacidad de abrir aplicaciones/protocolos externos;
- filesystem y APIs Node del proceso principal.

## Límites de confianza

1. **Contenido remoto no confiable → Chromium sandbox.** Cada página puede ser hostil.
2. **Renderer del shell → preload.** El shell forma parte del paquete, pero sigue sin Node integration.
3. **Preload → IPC main.** Solo métodos nominados, argumentos Zod y sender exacto.
4. **Main → sistema operativo.** Archivos locales, Keychain/cookies cifradas, diálogo y `shell.openExternal`.
5. **Perfil → perfil.** La partición Chromium es el límite de aislamiento de sesión.

## Controles

| Riesgo | Control del MVP |
|---|---|
| RCE desde una web | `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, sin preload remoto |
| acceso IPC remoto | bridge solo en shell; validación de `webContents.id`, frame y payload |
| navegación a código/local | allowlist `https:`, `http:`, `about:blank`; bloqueo de `javascript:`, `data:`, `file:` y esquemas desconocidos |
| popup privilegiado | handler explícito; mismas preferencias/sesión; adopción como tarjeta |
| escalada por permisos | permission check/request y device handlers deny-by-default |
| exfiltración por descarga | `will-download` cancelado |
| protocolo externo | allowlist + URL parseada + confirmación nativa |
| persistencia corrupta/inyectada | límite de tamaño, JSON/Zod, escritura `0600`, temporal+fsync+rename, backup |
| cruce de perfiles | una partición determinista por UUID; nunca copia manual de storage |
| manipulación de runtime Electron | fuses: no RunAsNode/NODE_OPTIONS/CLI inspector, ASAR integrity y only-load-ASAR |
| secretos en historial | solo URL/título; nunca `pageState`; límite de 500 entradas |

La CSP del shell bloquea scripts inline y recursos de red. `style-src-attr 'unsafe-inline'` se mantiene únicamente porque el canvas necesita valores geométricos dinámicos en atributos `style`; no habilita JavaScript inline.

## Datos en disco

Los perfiles persistentes son deliberadamente durables. En macOS, el fuse `EnableCookieEncryption` permite que Electron use Keychain para cookies cuando el build tiene identidad de firma consistente. El workspace JSON no está cifrado: URLs y títulos son visibles para cualquier proceso con acceso al usuario local.

Un perfil Temporal evita que OmniBrowser serialice su identidad, tarjetas, URLs e historial, y usa una partición de memoria. No se promete borrado antiforense de swap, memoria, DNS, proxies, logs del sistema o artefactos del sitio.

## Amenazas fuera de alcance

- atacante con control de la cuenta macOS o del proceso main;
- malware con permisos para leer/instrumentar la aplicación;
- vulnerabilidades 0-day de Chromium/Electron;
- anonimato de red, VPN/Tor o protección contra fingerprinting;
- un gestor de contraseñas;
- extensiones de Chromium;
- política OAuth de terceros;
- archivos descargados, porque las descargas no existen en el MVP.

## Reglas de cambio

Todo cambio que conceda un permiso, añada un protocolo, expanda el preload, permita descargas, modifique particiones o introduzca navegación local requiere:

1. amenaza y motivo documentados;
2. test negativo que demuestre el límite;
3. revisión del sender IPC y CSP;
4. repetición de POC relevantes;
5. actualización de este documento y del ADR si cambia una decisión.

Consulte [SECURITY.md](../SECURITY.md) para reportar una vulnerabilidad.

La evidencia y las limitaciones de las herramientas automáticas están registradas en [la auditoría de dependencias y hardening](security-audit.md).
