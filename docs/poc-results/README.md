# Resultados de pruebas de concepto

Fecha de ejecución de referencia: 2026-09-16.

## Entorno

| Campo | Valor |
|---|---|
| Equipo | Apple M4 Pro, 14 CPU lógicas, 48 GiB RAM |
| Arquitectura | arm64 |
| Sistema | macOS 27.0 (26A428) |
| Electron | 44.4.1 |
| Resolución Retina observada | `devicePixelRatio = 2` |

Los comandos usan fixtures HTTP locales y directorios temporales; no dependen de cuentas ni servicios externos.

## POC 1: perfiles y almacenamiento

```bash
npm run test:poc:storage
```

Resultado: pasa.

- A y B, con la misma partición persistente, leen el mismo token en cookie persistente, cookie de sesión, `localStorage`, IndexedDB y Cache Storage.
- C, con otra partición, no lee esos valores.
- A/B comparten el registro y control de service worker.
- La segunda carga valida uso de caché HTTP de la misma partición.
- Después de flush, cierre y relanzamiento: sobreviven cookie persistente, `localStorage`, IndexedDB, Cache Storage y service worker.
- La cookie sin expiración no reaparece.
- Una partición sin `persist:` comparte dentro del proceso y queda vacía al relanzar.
- Reasignar una tarjeta mediante destrucción/recreación cambia la sesión sin mutar el perfil de origen.

## POC 2: canvas con vistas nativas

```bash
npm run test:poc:canvas
```

Resultado: pasa.

- Tres `WebContentsView` siguen `screen = origin + pan + world × zoom`.
- Se comprobaron bounds de contenido, solapamiento, selección, re-add para z-order, resize, ocultamiento fuera del viewport y Retina 2×.
- Evidencia del shell: [`canvas-arm64.png`](canvas-arm64.png), 2400×1500 px.

macOS negó la captura compuesta de superficies nativas sin permiso de Screen Recording. El POC conserva captura del shell y valida los bounds/interacciones por API; esta limitación de evidencia está registrada y no se interpreta como fallo del canvas.

## POC 3: popups y autenticación

```bash
npm run test:poc:popup
```

Resultado: pasa.

- `window.open` y `target="_blank"` crean una tarjeta con la sesión del opener.
- El runtime adopta el `WebContents` suministrado por Electron.
- `window.opener`, `postMessage` y `window.close` se conservan.
- Un destino no permitido se bloquea.

Esto valida la primitiva, no garantiza aceptación de un proveedor OAuth concreto. Los proveedores pueden bloquear navegadores embebidos por política propia.

## POC 4: recursos y suspensión

```bash
npm run test:poc:resources
```

Resultado: pasa. Las cifras siguientes son working set total observado en KiB y solo describen el equipo indicado.

| Vistas | Visibles | Ocultas (`setVisible(false)`) | Fuera de viewport | Suspendidas | Reactivada una |
|---:|---:|---:|---:|---:|---:|
| 1 | 432,720 | 434,736 | 435,024 | 345,200 | 436,240 |
| 5 | 801,024 | 801,296 | 802,912 | 349,648 | 440,320 |
| 10 | 1,259,728 | 1,260,064 | 1,260,864 | 355,088 | 446,048 |

Interpretación limitada: ocultar reduce composición, pero no libera el working set como destruir los `WebContents`. La suspensión manual sí mostró una reducción grande en esta ejecución y el wake reconstruyó perfil, URL e historial. No se deduce un límite universal de tarjetas ni se activa autosuspensión.

## Ejecución agregada

```bash
npm run test:poc
```

El script falla al primer gate incumplido. Cada actualización de Electron debe volver a ejecutar los cuatro POC en arm64 y x64 antes de cambiar el ADR o generar una release.
