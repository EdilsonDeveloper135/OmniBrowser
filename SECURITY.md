# Política de seguridad

## Versiones soportadas

| Versión | Soporte de seguridad |
|---|---|
| `0.1.x` | Sí, durante el desarrollo del MVP |
| versiones anteriores | No |

Hasta la primera release firmada, los builds del repositorio son software de pre-release y no deben usarse con cuentas o secretos de alto valor.

## Reportar una vulnerabilidad

No abra un issue público con credenciales, cookies, datos de perfil, exploit funcional o instrucciones que pongan a usuarios en riesgo.

Use el [formulario privado de GitHub Security Advisories](https://github.com/EdilsonDeveloper135/OmniBrowser/security/advisories/new). Incluya:

- versión/commit y arquitectura;
- impacto y límite de confianza afectado;
- pasos mínimos reproducibles;
- prueba local sanitizada;
- mitigación sugerida, si existe.

El proyecto intentará confirmar recepción en 72 horas, evaluar severidad en siete días y mantener al reportante informado. Estos son objetivos de respuesta, no un SLA contractual.

## Alcance prioritario

- escape de sandbox o acceso Node desde contenido remoto;
- bypass del sender/validador IPC;
- lectura o escritura entre perfiles distintos;
- persistencia inesperada de perfiles Private, sus URLs, historial, zonas, stacks u orden;
- apertura externa o navegación a esquemas bloqueados sin confirmación;
- permiso concedido pese a la política deny-by-default, o descarga sin browser registrado/diálogo nativo;
- manipulación de workspace que produzca ejecución de código;
- bypass de fuses/integridad del paquete distribuido.

No se consideran vulnerabilidad por sí solos: que una web detecte Electron, que un proveedor OAuth rechace el flujo, que una cookie de sesión desaparezca al cerrar, un archivo que el usuario haya aceptado guardar, o artefactos forenses fuera del modelo declarado del perfil Private.

Consulte el [modelo de seguridad](docs/security-model.md) para activos, límites y amenazas fuera de alcance.
