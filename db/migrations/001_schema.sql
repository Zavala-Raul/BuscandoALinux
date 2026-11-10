-- =====================================================================
-- 001_schema.sql — Esquema del rally "Buscando a Linux"
-- Todo vive en el esquema privado "game". La aplicación se conecta con el
-- rol rally_app, que NO tiene privilegios sobre tablas (ver 003_grants.sql).
-- =====================================================================

create schema if not exists game;

-- Rol restringido para la aplicación. La contraseña/LOGIN se asigna desde
-- scripts/migrate.ts con RALLY_APP_PASSWORD (nunca se guarda en el repo).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rally_app') then
    create role rally_app nologin;
  end if;
end
$$;

create type game.event_status as enum ('draft', 'open', 'running', 'paused', 'closed');

-- ---------------------------------------------------------------------
-- Eventos
-- ---------------------------------------------------------------------
create table game.events (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9-]{1,40}$'),
  name          text not null check (char_length(name) between 1 and 120),
  status        game.event_status not null default 'draft',
  target_count  int  not null default 6 check (target_count between 1 and 50),
  is_test       boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Equipos
-- ---------------------------------------------------------------------
create table game.teams (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references game.events(id) on delete cascade,
  public_id   text not null check (public_id ~ '^[A-Z]{2,5}-[0-9]{3}$'),
  name        text not null check (char_length(name) between 1 and 60),
  status      text not null default 'active' check (status in ('active', 'disabled')),
  created_at  timestamptz not null default now(),
  unique (event_id, public_id),
  unique (event_id, id)
);

create table game.team_members (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null,
  team_id       uuid not null,
  display_name  text not null check (char_length(display_name) between 1 and 60),
  foreign key (event_id, team_id) references game.teams(event_id, id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Staff (credenciales individuales por evento)
-- ---------------------------------------------------------------------
create table game.staff (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references game.events(id) on delete cascade,
  username       text not null check (username ~ '^[a-z0-9_.-]{3,32}$'),
  display_name   text not null check (char_length(display_name) between 1 and 60),
  password_hash  text not null check (char_length(password_hash) between 20 and 300),
  is_active      boolean not null default true,
  -- Si el staff también juega en un equipo, no puede confirmar su propio equipo.
  team_id        uuid,
  created_at     timestamptz not null default now(),
  unique (event_id, username),
  unique (event_id, id),
  foreign key (event_id, team_id) references game.teams(event_id, id)
);

create table game.staff_roles (
  event_id  uuid not null,
  staff_id  uuid not null,
  role      text not null check (role in ('admin', 'final')),
  primary key (staff_id, role),
  foreign key (event_id, staff_id) references game.staff(event_id, id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Activación y sesiones (solo se guardan hashes HMAC-SHA256 en hex)
-- ---------------------------------------------------------------------
create table game.activation_tokens (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null,
  team_id     uuid not null,
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  -- Hash de una clave aleatoria generada por el navegador que canjeó el código.
  -- Permite reintentar la activación (p. ej. si se perdió la respuesta) SOLO
  -- desde ese mismo navegador y durante unos minutos, sin duplicar nada.
  used_client_key_hash text check (used_client_key_hash is null or used_client_key_hash ~ '^[0-9a-f]{64}$'),
  revoked_at  timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  foreign key (event_id, team_id) references game.teams(event_id, id) on delete cascade
);

create table game.sessions (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references game.events(id) on delete cascade,
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  kind            text not null check (kind in ('team', 'staff')),
  team_id         uuid,
  staff_id        uuid,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  revoked_reason  text check (revoked_reason is null or char_length(revoked_reason) <= 200),
  check (
    (kind = 'team'  and team_id  is not null and staff_id is null) or
    (kind = 'staff' and staff_id is not null and team_id  is null)
  ),
  foreign key (event_id, team_id)  references game.teams(event_id, id) on delete cascade,
  foreign key (event_id, staff_id) references game.staff(event_id, id) on delete cascade
);

-- Un solo acceso activo por equipo.
create unique index sessions_one_active_team
  on game.sessions (team_id) where kind = 'team' and revoked_at is null;

-- ---------------------------------------------------------------------
-- Puntos QR y pistas
-- ---------------------------------------------------------------------
create table game.qr_points (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references game.events(id) on delete cascade,
  -- Identificador aleatorio que va en la URL del QR (no enumerable).
  code         text not null unique check (code ~ '^[A-Za-z0-9]{22,64}$'),
  -- Clave interna estable para cargar contenido (ej. "biblioteca").
  slug         text not null check (slug ~ '^[a-z0-9-]{1,40}$'),
  -- Nombre que ve el equipo DESPUÉS de encontrar el punto.
  public_name  text not null check (char_length(public_name) between 1 and 80),
  is_active    boolean not null default true,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  unique (event_id, slug),
  unique (event_id, id)
);

create table game.clues (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null,
  target_qr_id  uuid not null,
  body          text not null check (char_length(body) between 1 and 1000),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  foreign key (event_id, target_qr_id) references game.qr_points(event_id, id) on delete cascade,
  unique (event_id, id),
  unique (event_id, id, target_qr_id)
);

-- ---------------------------------------------------------------------
-- Progreso: un registro por QR encontrado. El avance se CALCULA contando
-- registros válidos; no existe un contador editable.
-- ---------------------------------------------------------------------
create table game.team_scans (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null,
  team_id          uuid not null,
  qr_point_id      uuid not null,
  scanned_at       timestamptz not null default now(),
  source           text not null default 'scan' check (source in ('scan', 'admin')),
  created_by       uuid,
  reason           text check (reason is null or char_length(reason) between 3 and 500),
  voided_at        timestamptz,
  voided_by        uuid,
  void_reason      text check (void_reason is null or char_length(void_reason) between 3 and 500),
  foreign key (event_id, team_id)     references game.teams(event_id, id) on delete cascade,
  foreign key (event_id, qr_point_id) references game.qr_points(event_id, id) on delete cascade,
  check (source = 'scan' or reason is not null),
  check ((voided_at is null) = (void_reason is null))
);

-- Un QR registrado (válido) por equipo.
create unique index team_scans_one_per_qr
  on game.team_scans (team_id, qr_point_id) where voided_at is null;
create index team_scans_team on game.team_scans (team_id);

-- Apuntador: la pista vigente del equipo. La FK compuesta garantiza que
-- target_qr_id corresponde realmente a la pista asignada.
create table game.team_pointer (
  team_id       uuid primary key,
  event_id      uuid not null,
  clue_id       uuid not null,
  target_qr_id  uuid not null,
  assigned_at   timestamptz not null default now(),
  foreign key (event_id, team_id) references game.teams(event_id, id) on delete cascade,
  foreign key (event_id, clue_id, target_qr_id)
    references game.clues(event_id, id, target_qr_id) on delete cascade
);
create index team_pointer_target on game.team_pointer (target_qr_id);

-- ---------------------------------------------------------------------
-- Ubicación final (versionada)
-- ---------------------------------------------------------------------
create table game.final_locations (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null,
  version      int not null check (version >= 1),
  lat          double precision not null check (lat between -90 and 90),
  lng          double precision not null check (lng between -180 and 180),
  accuracy_m   double precision check (accuracy_m is null or (accuracy_m >= 0 and accuracy_m <= 100000)),
  reference    text not null check (char_length(reference) between 1 and 300),
  created_by   uuid not null,
  created_at   timestamptz not null default now(),
  unique (event_id, version),
  foreign key (event_id, created_by) references game.staff(event_id, id)
);

-- ---------------------------------------------------------------------
-- Llegadas confirmadas presencialmente
-- ---------------------------------------------------------------------
create table game.finishes (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null,
  team_id       uuid not null,
  position      int not null check (position >= 1),
  confirmed_by  uuid not null,
  confirmed_at  timestamptz not null default now(),
  voided_at     timestamptz,
  voided_by     uuid,
  void_reason   text check (void_reason is null or char_length(void_reason) between 3 and 500),
  unique (event_id, team_id),
  unique (event_id, position),
  foreign key (event_id, team_id) references game.teams(event_id, id) on delete cascade,
  foreign key (event_id, confirmed_by) references game.staff(event_id, id),
  check ((voided_at is null) = (void_reason is null))
);

-- ---------------------------------------------------------------------
-- Auditoría (sin tokens ni contraseñas)
-- ---------------------------------------------------------------------
create table game.audit_log (
  id          bigint generated always as identity primary key,
  event_id    uuid,
  actor_kind  text not null check (actor_kind in ('team', 'staff', 'system')),
  actor_id    uuid,
  action      text not null check (char_length(action) between 1 and 60),
  team_id     uuid,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_event_time on game.audit_log (event_id, created_at desc);

-- ---------------------------------------------------------------------
-- Límite de solicitudes (ventana fija)
-- ---------------------------------------------------------------------
create table game.rate_limits (
  key           text not null check (char_length(key) <= 200),
  window_start  timestamptz not null,
  hits          int not null default 0,
  primary key (key, window_start)
);

-- RLS activado en todas las tablas sin políticas permisivas: defensa adicional
-- por si algún día se concediera acceso directo por error.
alter table game.events            enable row level security;
alter table game.teams             enable row level security;
alter table game.team_members      enable row level security;
alter table game.staff             enable row level security;
alter table game.staff_roles       enable row level security;
alter table game.activation_tokens enable row level security;
alter table game.sessions          enable row level security;
alter table game.qr_points         enable row level security;
alter table game.clues             enable row level security;
alter table game.team_scans        enable row level security;
alter table game.team_pointer      enable row level security;
alter table game.final_locations   enable row level security;
alter table game.finishes          enable row level security;
alter table game.audit_log         enable row level security;
alter table game.rate_limits       enable row level security;
