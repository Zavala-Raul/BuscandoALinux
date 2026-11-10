# Guía de Despliegue y Recuperación (Vercel + Neon Postgres)

Esta guía describe cómo poner en marcha **Buscando a Linux** en local y en producción con **Vercel** y **Neon Postgres**, así como el protocolo de recuperación ante incidentes durante el evento.

---

## 1. Desarrollo y ensayo en local

1. **Variables de entorno:**
   ```powershell
   Copy-Item .env.example .env
   ```
2. **Levantar PostgreSQL 17 local en Docker:**
   ```powershell
   pnpm db:up
   ```
3. **Aplicar migraciones y configurar el rol restringido `rally_app`:**
   ```powershell
   pnpm db:migrate
   ```
4. **Cargar datos de prueba (`[PRUEBA]`, 10 equipos, 6 estaciones QR, 4 encargados) y generar el PDF de QR:**
   ```powershell
   pnpm db:seed:dev
   ```
   Esto genera en la carpeta `output/` (ignorada por Git):
   - `output/activation-codes-rally-dev.txt`: códigos de activación de un solo uso para `TEC-001` .. `TEC-010`.
   - `output/qr-sheets-rally-dev.pdf`: las 6 hojas tamaño Carta listas para imprimir.
   - `output/qr-reference-rally-dev.txt`: relación de estaciones y enlaces QR para control del staff.
5. **Iniciar servidor API y cliente web:**
   ```powershell
   pnpm dev
   ```
   - Web móvil: `http://localhost:5173`
   - Panel organizador final: `http://localhost:5173/final-staff`
   - Panel administración: `http://localhost:5173/admin`

---

## 2. Despliegue en Producción (Vercel + Neon)

### Paso 1: Crear el proyecto en Vercel y vincular Neon
1. Sube este repositorio a GitHub y créalo como proyecto en **Vercel** (`Framework Preset: Vite`).
2. En la pestaña **Storage** de tu proyecto de Vercel, selecciona **Create Database → Neon Postgres** y vincúlala al proyecto.
3. En la consola de Neon tendrás dos cadenas de conexión:
   - **Owner / Direct connection** (usuario propietario de la base, p. ej. `neondb_owner`): úsala **solo en tu máquina local** como `DATABASE_URL_OWNER` para correr migraciones, importar pistas y emitir hojas. **No la guardes en las variables de entorno de Vercel.**
   - **Pooled connection** (`-pooler`): úsala para el usuario restringido `rally_app` en la variable `DATABASE_URL` de Vercel.

### Paso 2: Ejecutar migraciones contra Neon desde tu equipo
En un archivo `.env.prod` local (que **nunca** se sube a Git):
```ini
DATABASE_URL_OWNER=postgresql://neondb_owner:...@ep-...neon.tech/neondb?sslmode=require
RALLY_APP_PASSWORD=<genera-una-contraseña-larga-aleatoria>
TOKEN_PEPPER=<genera-32-bytes-en-base64url>
EVENT_SLUG=rally-itnl-2026
APP_ORIGIN=https://tu-dominio.vercel.app
COOKIE_SECURE=true
```
Ejecuta:
```powershell
npx tsx --env-file=.env.prod scripts/migrate.ts
```

### Paso 3: Configurar variables en Vercel
En **Vercel → Project Settings → Environment Variables** (entorno *Production*):
- `DATABASE_URL`: `postgresql://rally_app:<RALLY_APP_PASSWORD>@ep-...-pooler...neon.tech/neondb?sslmode=require`
- `TOKEN_PEPPER`: el mismo valor aleatorio de 32+ caracteres usado al emitir códigos.
- `EVENT_SLUG`: `rally-itnl-2026`
- `APP_ORIGIN`: `https://tu-dominio.vercel.app`
- `COOKIE_SECURE`: `true`

### Paso 4: Cargar contenido definitivo, crear cuentas de los 4 encargados y emitir QR
1. Edita `content/clues.yaml` con el `slug: rally-itnl-2026`, `is_test: false`, los nombres reales de las 6 estaciones y sus pistas definitivas.
2. Importa el contenido:
   ```powershell
   npx tsx --env-file=.env.prod scripts/import-content.ts
   ```
3. Crea las 4 cuentas individuales de encargados (al menos 1 con rol `final`):
   ```powershell
   npx tsx --env-file=.env.prod scripts/create-staff.ts organizador1 "Encargado Final (Linux)" "<ContraseñaSegura1>" final,admin
   npx tsx --env-file=.env.prod scripts/create-staff.ts encargado2 "Encargado Apoyo 2" "<ContraseñaSegura2>" admin
   npx tsx --env-file=.env.prod scripts/create-staff.ts encargado3 "Encargado Apoyo 3" "<ContraseñaSegura3>" admin
   npx tsx --env-file=.env.prod scripts/create-staff.ts encargado4 "Encargado Apoyo 4" "<ContraseñaSegura4>" admin
   ```
4. Crea los equipos desde el panel `/admin` (o por script) y genera los códigos de activación y el PDF de QR:
   ```powershell
   npx tsx --env-file=.env.prod scripts/issue-codes.ts
   npx tsx --env-file=.env.prod scripts/print-qr.ts
   ```

---

## 3. Protocolo de recuperación durante el evento

| Incidencia | Cómo se resuelve (sin editar tablas manualmente) |
|---|---|
| **El teléfono de un equipo se queda sin batería, se daña o borra datos del navegador** | En `/admin`, buscar el equipo y pulsar **«Emitir nuevo código / Transferir acceso»** indicando el motivo (ej. *"Cambio de teléfono por batería"*). El servidor revoca de inmediato la sesión anterior, emite un nuevo código de un solo uso y **conserva los QR ya encontrados y su pista actual**. |
| **Un código QR impreso fue dañado o arrancado en una estación** | 1) Reponer con la copia impresa de respaldo.<br>2) Si un equipo está físicamente en la estación y lo reporta a un encargado, el administrador entra a `/admin` → **«Agregar QR manual»**, selecciona la estación y escribe el motivo. Queda registrado con `source = 'admin'` en la bitácora. |
| **El organizador final debe moverse de punto** | En `/final-staff`, captura la nueva ubicación (por GPS o manual), escribe la nueva referencia textual y pulsa **«Publicar ubicación»**. Se publica como `v2` (o siguiente) y todos los equipos con 6/6 ven un aviso de actualización con la hora. |
| **Lluvia, emergencia o interrupción técnica en el campus** | En `/admin`, cambiar el estado del evento a **`paused`** indicando el motivo. Mientras está en pausa no se aceptan escaneos ni llegadas competitivas, pero las sesiones y avances quedan congelados hasta volver a **`running`**. |
| **Confirmación presencial aplicada por error al equipo equivocado** | En `/admin`, usar **«Anular llegada»** sobre ese equipo con motivo obligatorio. La llegada queda marcada como anulada en auditoría y las posiciones oficiales se recalculan automáticamente. |
