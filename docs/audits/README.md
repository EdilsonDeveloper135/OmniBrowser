# Auditorías puntuales

Este directorio reúne los informes de auditoría de un barrido concreto: describen el estado del código en una fecha
dada, con su propia evidencia y hallazgos numerados, y no se reescriben más allá de una nota posterior que enlaza al
siguiente barrido. Para el estado vigente, use los documentos vivos en [`docs/`](..): `architecture.md`,
`security-model.md`, `security-audit.md`, `qa-inventory.md` y `release-checklist.md`, que sí se actualizan en el
mismo PR que cambia el comportamiento que describen.

## Índice cronológico

| Auditoría | Fecha | Alcance |
|---|---|---|
| [engineering-audit.md](engineering-audit.md) | 2026-09-16 | Auditoría técnica integral: baseline previo a la consolidación arquitectónica |
| [hardening-2026-09.md](hardening-2026-09.md) | 2026-09-17 | Hardening posterior al canvas espacial: dependencias, gestos, descargas y rendimiento |
| [agent-audit-2026-09.md](agent-audit-2026-09.md) | 2026-09-18 | Agentes Browser Use por tarjeta (ADR 0005): hallazgos A-01…A-30 y seguimiento con proveedor real y llavero |

Cada informe enlaza hacia atrás (base documental) con el barrido anterior, así que basta abrir el más reciente para
reconstruir la cadena completa.
