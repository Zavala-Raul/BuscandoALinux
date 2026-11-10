# Guía Rápida de Prueba — Administración y Registro de Equipos

Esta guía cubre todo el flujo que seguirán los encargados desde cero para configurar las estaciones QR, registrar a los ~12 equipos y operar el rally.

---

## 0. Iniciar el entorno local (si aún no está corriendo)

En la terminal, dentro de la carpeta del proyecto:
```powershell
pnpm db:up
pnpm dev
```
*(Si quieres asegurarte de empezar con todo en blanco antes de tu prueba, ejecuta `pnpm db:clean`).*

---

## Paso 1: Entrar al Panel de Administración

1. Abre en tu navegador: `http://localhost:5173/staff/login`
2. Inicia sesión con la cuenta de administrador/organizador:
   - **Usuario:** `organizador`
   - **Contraseña:** `dev-final-password`
3. Ve a `http://localhost:5173/admin`.

---

## Paso 2: Configurar la cantidad de QRs requeridos (Meta)

En la tarjeta **«Parámetros y Limpieza»** (arriba a la derecha):
1. **Nombre del evento:** escribe el nombre (ej. `Buscando a Linux — Rally ISC ITNL`).
2. **QRs necesarios para desbloquear la ubicación final (meta):**
   - **Para tu prueba rápida de hoy:** pon **`2`** o **`3`** (así puedes probar todo el recorrido en 2 minutos sin tener que escanear 10 QRs).
   - **Para el día del evento con ~12 equipos:** pon por ejemplo **`8`** o **`10`** (y crea 10–12 estaciones en el campus para que los equipos se repartan).
3. Haz clic en **«Guardar nombre y meta de QRs»**.

---

## Paso 3: Crear las Estaciones QR y sus Coordenadas

En la sección **«Estaciones QR»** → **«Crear o actualizar estación QR»** (columna izquierda):

1. **Identificador corto (slug):** escribe una clave sin espacios (ej. `biblioteca`).
2. **Nombre visible al escanear el QR:** escribe el nombre que verá el equipo cuando ya lo haya encontrado (ej. `Estación 1 — Biblioteca Central`).
3. **Orden (#):** `1`.
4. **Radio «Cerca de pista» (metros):** deja `35` (o el radio en metros al que quieres que les avise).
5. **Latitud y Longitud (opcional, para el radar «¡Cerca de una pista!»):**
   - Si estás físicamente en el lugar con tu celular o laptop, pulsa **«Usar mi ubicación GPS actual»** (para probar en tu escritorio, púlsalo ahora mismo: así tu ubicación actual quedará guardada en esa estación y verás cómo se activa el aviso verde *«¡Cerca de una pista!»* en la vista de equipo).
   - O escribe coordenadas manualmente (ej. Latitud `27.476300`, Longitud `-99.516400`).
6. Pulsa **«Guardar estación QR»**.
7. Repite esto para crear al menos tantas estaciones como la meta que pusiste en el Paso 2 (por ejemplo: `biblioteca`, `lab-computo`, `explanada`).

---

## Paso 4: Agregar Pistas a cada Estación QR

En la columna derecha (**«Agregar pista que apunte a una estación»**):

1. En **«Estación destino a la que apunta la pista»**, elige la estación (ej. `biblioteca`).
2. En **«Texto de la pista para los equipos»**, escribe la pista (ej. *«Donde el silencio compila mejor que cualquier IDE: busca en la entrada de consulta.»*).
3. Pulsa **«Agregar pista a estación»**.
4. Agrega al menos **1 o 2 pistas por cada estación** que hayas creado.
   - Verás las pistas listadas dentro de la tarjeta de cada estación abajo, y puedes borrar cualquiera con el botón **`×`**.

---

## Paso 5: Flujo de Trabajo para Registrar a los Equipos (~12 equipos)

Este es el flujo exacto que seguirás antes o durante la mesa de registro del evento:

### A) Dar de alta a cada equipo
En la tarjeta **«Registro en Mesa → Crear nuevo equipo»**:
1. **ID público:** escribe `1` o `TEC-001` (el sistema lo convierte automáticamente a `TEC-001`, luego `TEC-002`, ..., `TEC-012`).
2. **Nombre del equipo:** escribe el nombre elegido por los 5 integrantes (ej. `Kernel Panic`).
3. **Integrantes (opcional):** nombres separados por coma.
4. Pulsa **«Crear equipo»**.

### B) Entregar su código de activación (un solo teléfono por equipo)
Tienes dos formas de hacerlo:
- **Opción 1 — En vivo desde la tabla de `/admin` (ideal en mesa de registro):**
  1. En la tabla **«Equipos registrados»**, ubica la fila de `TEC-001` y pulsa el botón azul **«Emitir código»**.
  2. Arriba de la tabla aparecerá un recuadro verde con el código de un solo uso (formato `XXXX-XXXX-XXXX`).
  3. El representante del equipo abre la web en su celular (`/acceso`), escribe ese código y queda activado al instante.
- **Opción 2 — Generar hoja imprimible con todos los códigos por lote:**
  - Ejecuta en terminal `pnpm codes:issue` y se creará el archivo `output/activation-codes-rally-dev.txt` con los recortes de todos los equipos creados.

### C) ¿Qué pasa si a un equipo se le apaga el celular a mitad del juego?
1. El equipo acude a la mesa de administración y dice su ID (`TEC-001`).
2. En la tabla de `/admin`, pulsas **«Emitir código»** en la fila de `TEC-001` (o usas el formulario *«Emitir credencial de activación»* indicando el motivo).
3. El servidor **revoca inmediatamente el teléfono anterior**, te da un código nuevo para el segundo teléfono y **conserva todos los QRs que ya llevaban registrados**.

---

## Paso 6: Publicar la Ubicación Final (donde está Linux)

1. Desde `/admin`, haz clic arriba a la derecha en **«Panel Meta Final»** (`/final-staff`).
2. En **«1. Publicar ubicación final»**:
   - Pulsa **«Obtener mi ubicación actual (GPS)»** (o escribe latitud y longitud, por ejemplo `27.4765`, `-99.5160`).
   - Escribe la **Referencia textual en el campus** (ej. *«Junto a la banca techada frente al edificio de Sistemas, con la mascota de Linux»*).
   - Pulsa **«Publicar ubicación»**.
   - *(Nadie podrá ver estas coordenadas hasta que su equipo complete todos los QRs de la meta).*

---

## Paso 7: Arrancar el Rally y Confirmar Llegadas

1. En `/admin`, asegúrate de que el **Estado operativo** esté en:
   - **`open`** mientras los equipos están canjeando su código en la mesa de registro (aún no les deja escanear QRs).
   - **`running`** en el momento exacto de dar el banderazo de salida.
2. Para generar el PDF con las hojas de los códigos QR listas para imprimir:
   - Ejecuta `pnpm qr:print` y abre `output/qr-sheets-rally-dev.pdf`.
   - *(Para probar en tu computadora sin imprimir nada, en la tarjeta de cada estación dentro de `/admin` haz clic en **«Copiar enlace QR»**).*
3. Cuando un equipo complete todos los QRs y llegue corriendo con el Organizador Final:
   - En `/final-staff`, sección **«2. Confirmar llegada presencial»**, escribe su ID (`TEC-001` o `1`) y pulsa **«Buscar equipo»**.
   - Verifica que diga **«Habilitado (cumple meta de QRs)»** y pulsa **«Confirmar llegada presencial»**.
   - El servidor le asignará oficialmente el lugar **`#1`** (y puedes seguir confirmando al `#2`, `#3`, etc.).
