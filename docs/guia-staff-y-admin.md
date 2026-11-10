# Guía Breve para Administración y Encargados (4 personas)

## 1. Distribución sugerida de los 4 encargados

1. **Encargado 1 — Organizador Final (quien tiene a Linux):**
   - Entra a `/staff/login` → `/final-staff`.
   - Permanece en el punto final del campus con la figura/mascota de Linux.
   - Antes o durante el arranque, publica su ubicación exacta desde su teléfono y verifica que el enlace a Google Maps abra en el lugar correcto.
   - Cuando llega un equipo, le pide su **ID público** (`TEC-001`), lo consulta y confirma la llegada presencial.
2. **Encargado 2 — Mesa de Control / Administración:**
   - Entra a `/admin`.
   - Cambia el estado del evento (`open` → `running` al dar el banderazo).
   - Atiende incidencias (transferencia de teléfono si se apaga la batería de un equipo, reposición o alta manual justificada de un QR).
3. **Encargados 3 y 4 — Ronda en campus:**
   - Llevan copias impresas de repuesto de los 6 QR y la hoja de incidencias por estación.
   - Supervisan que las hojas QR sigan visibles en las 6 estaciones.

---

## 2. Lista de verificación antes de arrancar (15 minutos antes)

- [ ] **Estado del evento:** poner en `open` para que los 10 equipos canjeen su código de activación en `/acceso`, sin poder registrar QR todavía.
- [ ] **6 estaciones QR colocadas:** verificar con `output/qr-reference-<evento>.txt` que cada hoja impresa está en su lugar y que al menos una copia de respaldo la tienen los encargados en ronda.
- [ ] **Ubicación final publicada (`v1`):** el Organizador Final entra a `/final-staff`, pulsa **«Obtener mi ubicación actual (GPS)»**, escribe una referencia clara (ej. *"Banca techada frente al edificio X, junto al árbol grande"*) y publica.
- [ ] **Banderazo de salida:** cambiar el estado del evento a **`running`** en `/admin`. En ese instante todos los equipos reciben su pista inicial y pueden registrar QR.

---

## 3. Reglas operativas rápidas

- **Un teléfono activo por equipo:** solo un integrante lleva la sesión abierta. Si necesitan cambiar de celular, pasan con Administración para emitir un nuevo código (no pierden su avance).
- **Abrir la cámara vs. registrar:** al escanear un QR se abre `/q/<código>`; el equipo debe tocar el botón **«Registrar este punto»** para que el servidor lo cuente.
- **Orden libre y 6 de 6:** cualquier QR válido cuenta. La pista que ven en pantalla siempre apunta a una estación que **todavía no han registrado**. Al juntar **6 de 6**, se desbloquea el mapa y la referencia hacia el Organizador Final.
- **Criterio de desempate / ganador:** gana el primer equipo con **6 de 6** cuya llegada presencial sea confirmada en `/final-staff`. El servidor asigna el orden (`#1`, `#2`, `#3`...) en serie.

---

## 4. Plantilla de hoja de incidencias en papel (respaldo por estación)

En caso de pérdida total de señal celular en un punto del campus, el encargado en ronda anota:

| Hora | ID Equipo (`TEC-00X`) | Estación (`#1..#6`) | Motivo (sin señal / QR dañado) | Firma encargado |
|---|---|---|---|---|
| | | | | |
| | | | | |

Al recuperar señal o llegar a la mesa de control, el administrador incorpora el registro en `/admin` indicando el motivo y el nombre del encargado que lo validó.
