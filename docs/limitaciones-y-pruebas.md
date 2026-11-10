# Limitaciones Conocidas y Resultados de las Pruebas (§17 y §18)

## 1. Resultados de la suite de aceptación obligatoria (`pnpm test`)

Todas las pruebas se ejecutan contra **PostgreSQL 17 real** con las migraciones `001_schema.sql`, `002_functions.sql` y `003_grants.sql` aplicadas y conectándose mediante el rol restringido `rally_app`:

| Criterio (§17) | Estado | Evidencia en `tests/integration/acceptance.test.ts` |
|---|---|---|
| Dos equipos pueden registrar el mismo QR independientemente | ✅ Pasa | `TEC-001` y `TEC-002` registran la misma estación y ambos quedan en `1/6` |
| Un equipo no puede registrar dos veces el mismo QR | ✅ Pasa | Índice único parcial `team_scans_one_per_qr` + `ON CONFLICT DO NOTHING` devuelve `already_registered` sin duplicar |
| Recargar conserva la pista asignada | ✅ Pasa | Consultas sucesivas a `GET /api/me` devuelven el mismo `clue.id` guardado en `game.team_pointer` |
| La pista nunca apunta a un QR ya registrado por el equipo (y si encuentra otro QR distinto al apuntado, su pista vigente se conserva) | ✅ Pasa | Prueba exhaustiva sobre las **64 combinaciones ($2^6$)** de subconjuntos de los 6 QR verificando que `target_qr_id` nunca pertenece al conjunto de QR ya registrados |
| Escaneos simultáneos no crean duplicados ni inconsistencias | ✅ Pasa | 10 peticiones `POST /api/team/scan` concurrentes (`Promise.all`) bloquean la fila del equipo (`SELECT ... FOR UPDATE`) y producen 1 `registered` y 9 `already_registered` |
| Manipular `team_id`, nivel, contador o rol no cambia permisos | ✅ Pasa | Esquemas Zod con `.strict()` rechazan cualquier campo extra (`400`); la identidad sale exclusivamente del hash de sesión en cookie `HttpOnly` |
| Un jugador no puede leer ni escribir tablas directamente | ✅ Pasa | `rally_app` recibe `permission denied` en `SELECT`/`INSERT` sobre `game.teams`, `game.team_scans`, `game.final_locations` y funciones internas `game._*` |
| Un encargado no puede confirmar a su propio equipo si participa | ✅ Pasa | `game.final_confirm` comprueba `staff.team_id = team.id` y rechaza con `403 own_team_forbidden` |
| Una sesión revocada deja de funcionar inmediatamente | ✅ Pasa | Al emitir un nuevo código en `/api/admin/issue-activation`, la sesión anterior recibe `401 session_invalid` y el nuevo teléfono conserva todo el avance |
| Un equipo con menos de 6 QR (p. ej. 5/6) no obtiene coordenadas por ningún endpoint | ✅ Pasa | `GET /api/me` devuelve `final: null` y `GET /api/team/final-location` devuelve `403 final_locked` |
| 6 de 6 QR válidos habilitan la ubicación final | ✅ Pasa | Al registrar el 6.º QR, `GET /api/team/final-location` entrega coordenadas, precisión, referencia y versión |
| Llegar físicamente sin los 6 QR no permite finalizar | ✅ Pasa | `POST /api/final/confirm` devuelve `409 not_eligible` |
| Solicitudes repetidas o simultáneas de finalización no duplican llegadas y serializan el orden | ✅ Pasa | Bloqueo `FOR UPDATE` sobre `game.events` asigna `position` (`#1`, `#2`, ...) en serie y devuelve `already_confirmed` en reintentos |
| Pausar o cerrar el evento bloquea escaneos y llegadas competitivas | ✅ Pasa | Con `status = 'paused'`, `scan_qr` y `final_confirm` devuelven `409 event_not_running`, mientras las correcciones administrativas auditadas siguen disponibles |
| Los archivos compilados (`dist/`) no contienen secretos, pistas ni coordenadas | ✅ Pasa | `pnpm check:bundle` inspecciona todos los activos generados por Vite |

---

## 2. Resultado de la prueba de carga y ráfaga (`pnpm test:load`)

Escenario ejecutado (`scripts/load-test.ts`):
- **10 equipos** activando sesión en ráfaga simultánea.
- **Ráfaga concurrente** de los 10 equipos registrando los **6 QR** y consultando `/api/me` y `/api/team/final-location`.
- **10 confirmaciones presenciales simultáneas** en la meta.

Resultados medidos:
- **Operaciones totales:** 152 peticiones HTTP autenticadas y transaccionales.
- **Errores 5xx o colisiones:** `0`.
- **Latencia mediana (p50):** `15.1 ms`.
- **Latencia percentil 95 (p95):** `105.0 ms`.
- **Latencia máxima:** `131.7 ms`.
- **Serialización de llegadas:** posiciones `1..10` asignadas exactamente una vez sin duplicados.

---

## 3. Limitaciones conocidas y consideraciones operativas

1. **QR estáticos sin encargado fijo en cada estación:** como se acordó en el diseño, las estaciones tienen QR impresos sin validación presencial por estación (los 4 encargados se reparten en meta, mesa de control y ronda). La llegada ganadora **sí** requiere confirmación presencial ante el Organizador Final y haber registrado los **6 de 6** puntos.
2. **Conectividad requerida para acciones oficiales:** cuando un teléfono pierde señal en un pasillo o sótano del campus, la aplicación muestra el último estado conocido bajo el aviso `"Sin conexión"`, pero registrar un QR requiere conexión con el servidor. Si una estación presenta caída total de red, se utiliza la hoja de incidencias para alta manual justificada en `/admin`.
3. **Arranque en frío (cold start) en Vercel + Neon:** en el plan gratuito de Vercel y Neon, la primera petición tras varios minutos de inactividad puede tardar ~1–2 segundos mientras despierta el cómputo de Neon. **Recomendación:** abrir `/admin` y cambiar el evento a `open` 15 minutos antes del inicio para mantener la conexión tibia durante todo el rally.
