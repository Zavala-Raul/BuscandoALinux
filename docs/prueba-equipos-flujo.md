# Guía Rápida de Prueba — Recorrido de un Equipo (Jugadores)

Esta guía explica paso a paso cómo funciona la aplicación desde el teléfono de un equipo (o desde una ventana de incógnito en tu computadora para probar).

> **Tip para probar en la misma computadora:** Abre una ventana de incógnito (o un segundo navegador) para simular el celular del equipo `TEC-001`, mientras en tu ventana normal tienes abierto `/admin` y `/final-staff`.

---

## Paso 1: Activar la sesión del equipo (`/acceso`)

1. En la ventana de incógnito (o celular del equipo), abre: `http://localhost:5173/acceso`
2. Escribe el **código de activación de un solo uso** que te dio el administrador al registrarte (ej. `XXXX-XXXX-XXXX`, con o sin guiones).
3. Toca **«Activar mi equipo»**.
4. El servidor vincula tu navegador al equipo (`TEC-001`) y te lleva automáticamente a la pantalla principal (`/`).

---

## Paso 2: Ver tu Pista Actual y el Radar de Cercanía (`/`)

En la pantalla principal verás:
1. **Tu ID público** arriba a la derecha (ej. `TEC-001`) y el estado del evento (`En curso`).
2. **Progreso de estaciones QR:** las casillas de los QRs que necesitas juntar (ej. `0 / 3` o `0 / 8`).
3. **Tarjeta «Pista actual»:** el acertijo o pista que te guía hacia una estación QR que **todavía no tienes registrada**.
   - Si recargas la página o cierras y abres el navegador, **conservas exactamente la misma pista**.
4. **Radar de Cercanía GPS** *(aparece si la estación tiene coordenadas configuradas)*:
   - Toca **«¿Estoy cerca de una pista?»** (o **«Activar radar mientras camino»** para que revise cada 12 segundos).
   - El navegador pide permiso de ubicación y consulta al servidor (las coordenadas de los QRs nunca viajan a tu teléfono).
   - Recibirás uno de tres avisos:
     - 🟢 **«¡Cerca de una pista!»**: estás dentro del radio de una estación QR sin registrar (además te dice si es la estación de tu pista actual).
     - 🟡 **«Te estás acercando»**: estás a pocos metros de una estación pendiente.
     - 🔵 **«Aún no estás cerca»**: sigue buscando con ayuda de la pista.

---

## Paso 3: Escanear y Registrar un Punto QR (`/q/:code`)

1. Cuando el equipo encuentra una hoja QR física en el campus, la escanea con la cámara de su teléfono (que abre el enlace `/q/<código>`).
   - *Para probar en tu computadora:* copia el enlace desde el botón **«Copiar enlace QR»** en `/admin` y pégalo en la ventana del equipo (o pégalo en el recuadro *«¿Tu cámara abrió otro navegador?»* al final de la pantalla del equipo).
2. Se abrirá la pantalla de confirmación del punto:
   - **Importante:** solo abrir el enlace no registra nada; debes tocar el botón **«Registrar este punto»**.
3. Al tocar **«Registrar este punto»**:
   - **Si es un QR nuevo:** el servidor suma `+1` a tu progreso, marca el nombre de la estación como encontrada y actualiza tu apuntador:
     - Si encontraste la estación que decía tu pista, el servidor te asigna una **nueva pista** hacia otra estación que **no hayas visitado** (nunca te repetirá un QR que ya tengas).
     - Si por casualidad encontraste otro QR distinto en el camino, también te lo cuenta y conserva tu pista actual para que aún puedas ir por ella.
   - **Si intentas escanear el mismo QR otra vez:** aparece el aviso **«Este QR ya fue registrado»** sin sumar puntos duplicados.

---

## Paso 4: Desbloquear la Ubicación Final de Linux (`/final`)

1. Repite el Paso 3 con las demás estaciones hasta completar la meta (por ejemplo, `3 / 3` o `8 / 8`).
2. En cuanto registras el último QR requerido:
   - Desaparecen las pistas de búsqueda y se desbloquea automáticamente la tarjeta **«Ubicación final desbloqueada»** (y la pantalla `/final`).
   - Verás la **Referencia en el campus** escrita por el organizador, las **coordenadas**, la **versión** (`v1`, `v2`...) y el botón **«Abrir en Google Maps»**.
   - *(Si intentas entrar a `/final` o consultar `/api/team/final-location` cuando te falta aunque sea 1 QR, el servidor lo bloquea con error `403`).*

---

## Paso 5: Llegada Presencial y Confirmación del Ganador

1. El equipo corre con sus 5 integrantes al punto indicado en el mapa donde los espera el Organizador Final con Linux.
2. Al llegar, le muestran su pantalla con su ID público (**`TEC-001`**).
3. El Organizador Final ingresa `TEC-001` en su panel (`/final-staff`) y toca **«Confirmar llegada presencial»**.
4. En menos de unos segundos (o al tocar *«Actualizar estado»*), la pantalla del equipo se actualiza con el trofeo oficial:
   - **«¡Encontraron a Linux! — Posición oficial registrada: #1»** y la hora exacta del servidor.
