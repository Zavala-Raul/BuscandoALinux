-- =====================================================================
-- 002_functions.sql — Operaciones del juego.
--
-- Convenciones:
--  * Funciones públicas (para rally_app): SECURITY DEFINER, search_path = ''.
--    Reciben SOLO hashes de tokens; la identidad se deriva de la sesión.
--  * Funciones internas (prefijo _): sin SECURITY DEFINER y sin EXECUTE para
--    nadie más que el dueño; solo se invocan desde las funciones públicas.
--  * Errores de negocio: SQLSTATE 'GX000' con un código en el mensaje.
--  * Cada función pública es UNA transacción atómica (compatible con pooler).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Utilidades internas
-- ---------------------------------------------------------------------
create or replace function game._fail(p_code text) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'GX000', message = p_code;
end
$$;

create or replace function game._check_hash(p_hash text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    perform game._fail('bad_request');
  end if;
end
$$;

create or replace function game._audit(
  p_event_id uuid, p_actor_kind text, p_actor_id uuid, p_action text,
  p_team_id uuid, p_details jsonb default '{}'::jsonb
) returns void
language sql set search_path = '' as $$
  insert into game.audit_log (event_id, actor_kind, actor_id, action, team_id, details)
  values (p_event_id, p_actor_kind, p_actor_id, p_action, p_team_id, coalesce(p_details, '{}'::jsonb));
$$;

create or replace function game._found_count(p_team_id uuid) returns int
language sql stable set search_path = '' as $$
  select count(*)::int from game.team_scans
  where team_id = p_team_id and voided_at is null;
$$;

-- Sesión de equipo vigente (no revocada, no vencida, equipo activo).
create or replace function game._team_session(
  p_hash text, out o_session_id uuid, out o_team_id uuid, out o_event_id uuid
)
language plpgsql stable set search_path = '' as $$
begin
  perform game._check_hash(p_hash);
  select s.id, s.team_id, s.event_id
    into o_session_id, o_team_id, o_event_id
  from game.sessions s
  join game.teams t on t.id = s.team_id
  where s.token_hash = p_hash
    and s.kind = 'team'
    and s.revoked_at is null
    and s.expires_at > now()
    and t.status = 'active';
  if not found then
    perform game._fail('session_invalid');
  end if;
end
$$;

-- Sesión de staff vigente. Si p_roles no es null, exige al menos uno.
create or replace function game._staff_session(
  p_hash text, p_roles text[],
  out o_staff_id uuid, out o_event_id uuid, out o_team_id uuid, out o_roles text[]
)
language plpgsql stable set search_path = '' as $$
begin
  perform game._check_hash(p_hash);
  select st.id, st.event_id, st.team_id,
         coalesce((select array_agg(r.role order by r.role) from game.staff_roles r where r.staff_id = st.id), '{}')
    into o_staff_id, o_event_id, o_team_id, o_roles
  from game.sessions s
  join game.staff st on st.id = s.staff_id
  where s.token_hash = p_hash
    and s.kind = 'staff'
    and s.revoked_at is null
    and s.expires_at > now()
    and st.is_active;
  if not found then
    perform game._fail('session_invalid');
  end if;
  if p_roles is not null and not (o_roles && p_roles) then
    perform game._fail('forbidden');
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Apuntador de pistas.
-- Garantía: la pista vigente NUNCA apunta a un QR ya registrado por el equipo.
--  1. Si la pista actual sigue apuntando a un QR no registrado (y activa), se conserva.
--  2. Si no, se elige entre QR activos NO registrados, el que tenga menos
--     equipos apuntándole (reparte a los equipos); empate al azar. Luego una
--     variante de pista al azar para ese QR.
--  3. Si no quedan candidatos, se elimina el apuntador.
-- Debe llamarse con la fila del equipo ya bloqueada.
-- ---------------------------------------------------------------------
create or replace function game._repoint(p_team_id uuid, p_event_id uuid) returns void
language plpgsql set search_path = '' as $$
declare
  v_cur   game.team_pointer%rowtype;
  v_qr    uuid;
  v_clue  uuid;
begin
  select * into v_cur from game.team_pointer where team_id = p_team_id for update;
  if found then
    if exists (
         select 1 from game.clues c
         join game.qr_points q on q.id = c.target_qr_id
         where c.id = v_cur.clue_id and c.is_active and q.is_active)
       and not exists (
         select 1 from game.team_scans s
         where s.team_id = p_team_id and s.qr_point_id = v_cur.target_qr_id and s.voided_at is null)
    then
      return;
    end if;
  end if;

  select q.id into v_qr
  from game.qr_points q
  where q.event_id = p_event_id
    and q.is_active
    and not exists (
      select 1 from game.team_scans s
      where s.team_id = p_team_id and s.qr_point_id = q.id and s.voided_at is null)
    and exists (
      select 1 from game.clues c where c.target_qr_id = q.id and c.is_active)
  order by (
      select count(*) from game.team_pointer p
      where p.target_qr_id = q.id and p.team_id <> p_team_id),
    random()
  limit 1;

  if v_qr is null then
    delete from game.team_pointer where team_id = p_team_id;
    return;
  end if;

  select c.id into v_clue
  from game.clues c
  where c.target_qr_id = v_qr and c.is_active
  order by random()
  limit 1;

  insert into game.team_pointer (team_id, event_id, clue_id, target_qr_id, assigned_at)
  values (p_team_id, p_event_id, v_clue, v_qr, now())
  on conflict (team_id) do update
    set clue_id = excluded.clue_id,
        target_qr_id = excluded.target_qr_id,
        assigned_at = excluded.assigned_at;
end
$$;

-- Recalcula el apuntador según el avance (o lo elimina si ya completó).
create or replace function game._sync_pointer(p_team_id uuid, p_event_id uuid) returns void
language plpgsql set search_path = '' as $$
declare
  v_target int;
begin
  select target_count into v_target from game.events where id = p_event_id;
  if game._found_count(p_team_id) >= v_target then
    delete from game.team_pointer where team_id = p_team_id;
  else
    perform game._repoint(p_team_id, p_event_id);
  end if;
end
$$;

-- Clasificación oficial: posición entre llegadas no anuladas.
create or replace function game._finish_rank(p_finish_id uuid) returns int
language sql stable set search_path = '' as $$
  select count(*)::int
  from game.finishes f2
  join game.finishes f on f.id = p_finish_id
  where f2.event_id = f.event_id and f2.voided_at is null and f2.position <= f.position;
$$;

-- Estado visible para el equipo. Solo información del propio equipo.
-- Nunca incluye coordenadas finales.
create or replace function game._team_state(p_team_id uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_team    game.teams%rowtype;
  v_event   game.events%rowtype;
  v_found   int;
  v_clue    jsonb := null;
  v_final   jsonb := null;
  v_finish  jsonb := null;
  v_loc     game.final_locations%rowtype;
begin
  select * into v_team from game.teams where id = p_team_id;
  select * into v_event from game.events where id = v_team.event_id;
  v_found := game._found_count(p_team_id);

  if v_found < v_event.target_count and v_event.status in ('running', 'paused') then
    select jsonb_build_object('id', c.id, 'body', c.body, 'assigned_at', p.assigned_at)
      into v_clue
    from game.team_pointer p
    join game.clues c on c.id = p.clue_id
    where p.team_id = p_team_id;
  end if;

  if v_found >= v_event.target_count then
    select * into v_loc from game.final_locations
    where event_id = v_event.id order by version desc limit 1;
    if found then
      v_final := jsonb_build_object('unlocked', true, 'published', true,
                                    'version', v_loc.version, 'updated_at', v_loc.created_at);
    else
      v_final := jsonb_build_object('unlocked', true, 'published', false,
                                    'version', null, 'updated_at', null);
    end if;
  end if;

  select jsonb_build_object('rank', game._finish_rank(f.id), 'confirmed_at', f.confirmed_at)
    into v_finish
  from game.finishes f
  where f.team_id = p_team_id and f.voided_at is null;

  return jsonb_build_object(
    'team',  jsonb_build_object('public_id', v_team.public_id, 'name', v_team.name),
    'event', jsonb_build_object('name', v_event.name, 'status', v_event.status, 'target', v_event.target_count),
    'found_count', v_found,
    'found', coalesce((
      select jsonb_agg(jsonb_build_object('name', q.public_name, 'scanned_at', s.scanned_at) order by s.scanned_at)
      from game.team_scans s join game.qr_points q on q.id = s.qr_point_id
      where s.team_id = p_team_id and s.voided_at is null), '[]'::jsonb),
    'clue',   v_clue,
    'final',  v_final,
    'finish', v_finish,
    'server_time', now()
  );
end
$$;

-- ---------------------------------------------------------------------
-- Límite de solicitudes (ventana fija). Devuelve true si se permite.
-- ---------------------------------------------------------------------
create or replace function game.rate_hit(p_key text, p_window_seconds int, p_max int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_ws   timestamptz;
  v_hits int;
begin
  if p_key is null or char_length(p_key) > 200 or p_window_seconds not between 1 and 86400 then
    perform game._fail('bad_request');
  end if;
  v_ws := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into game.rate_limits as r (key, window_start, hits)
  values (p_key, v_ws, 1)
  on conflict (key, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  if random() < 0.01 then
    delete from game.rate_limits where window_start < now() - interval '2 hours';
  end if;
  return v_hits <= p_max;
end
$$;

-- =====================================================================
-- EQUIPOS
-- =====================================================================

-- Canjea un código de activación y crea la sesión única del equipo.
create or replace function game.activate_team(
  p_code_hash text, p_session_hash text, p_client_key_hash text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tok          game.activation_tokens%rowtype;
  v_team_status  text;
  v_event_status game.event_status;
  v_retry        boolean := false;
begin
  perform game._check_hash(p_code_hash);
  perform game._check_hash(p_session_hash);
  perform game._check_hash(p_client_key_hash);

  select * into v_tok from game.activation_tokens where token_hash = p_code_hash for update;
  if not found or v_tok.revoked_at is not null or v_tok.expires_at <= now() then
    perform game._fail('activation_invalid');
  end if;

  if v_tok.used_at is not null then
    -- Reintento idempotente: mismo navegador, dentro de 10 minutos.
    if v_tok.used_client_key_hash = p_client_key_hash and v_tok.used_at > now() - interval '10 minutes' then
      v_retry := true;
    else
      perform game._fail('activation_invalid');
    end if;
  end if;

  select t.status, e.status into v_team_status, v_event_status
  from game.teams t join game.events e on e.id = t.event_id
  where t.id = v_tok.team_id
  for update of t;

  if v_team_status <> 'active' then
    perform game._fail('team_disabled');
  end if;
  if v_event_status not in ('open', 'running', 'paused') then
    perform game._fail('event_not_open');
  end if;

  if not v_retry then
    update game.activation_tokens
       set used_at = now(), used_client_key_hash = p_client_key_hash
     where id = v_tok.id;
  end if;

  -- Un solo acceso activo: revocar cualquier sesión previa del equipo.
  update game.sessions
     set revoked_at = now(), revoked_reason = case when v_retry then 'activation_retry' else 'reactivated' end
   where team_id = v_tok.team_id and kind = 'team' and revoked_at is null;

  insert into game.sessions (event_id, token_hash, kind, team_id, expires_at)
  values (v_tok.event_id, p_session_hash, 'team', v_tok.team_id, now() + interval '24 hours');

  perform game._sync_pointer(v_tok.team_id, v_tok.event_id);
  perform game._audit(v_tok.event_id, 'team', v_tok.team_id,
                      case when v_retry then 'team_activate_retry' else 'team_activate' end,
                      v_tok.team_id, jsonb_build_object('token_id', v_tok.id));

  return game._team_state(v_tok.team_id);
end
$$;

create or replace function game.get_my_state(p_session_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx record;
begin
  select * into v_ctx from game._team_session(p_session_hash);
  return game._team_state(v_ctx.o_team_id);
end
$$;

-- Registra un QR para el equipo de la sesión.
-- Idempotente: repetir el mismo QR devuelve 'already_registered' sin duplicar.
create or replace function game.scan_qr(p_session_hash text, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx     record;
  v_status  game.event_status;
  v_qr      game.qr_points%rowtype;
  v_id      uuid;
begin
  select * into v_ctx from game._team_session(p_session_hash);

  if p_code is null or p_code !~ '^[A-Za-z0-9]{22,64}$' then
    perform game._fail('qr_invalid');
  end if;

  -- Serializa todas las operaciones del equipo.
  perform 1 from game.teams where id = v_ctx.o_team_id for update;

  select status into v_status from game.events where id = v_ctx.o_event_id;
  if v_status <> 'running' then
    perform game._fail('event_not_running');
  end if;

  select * into v_qr from game.qr_points
  where event_id = v_ctx.o_event_id and code = p_code and is_active;
  if not found then
    perform game._fail('qr_invalid');
  end if;

  insert into game.team_scans (event_id, team_id, qr_point_id, source)
  values (v_ctx.o_event_id, v_ctx.o_team_id, v_qr.id, 'scan')
  on conflict (team_id, qr_point_id) where voided_at is null do nothing
  returning id into v_id;

  if v_id is not null then
    perform game._sync_pointer(v_ctx.o_team_id, v_ctx.o_event_id);
  end if;

  return jsonb_build_object(
    'result', case when v_id is null then 'already_registered' else 'registered' end,
    'qr_name', v_qr.public_name,
    'state', game._team_state(v_ctx.o_team_id)
  );
end
$$;

-- Coordenadas finales: SOLO con todos los QR encontrados.
create or replace function game.get_final_location(p_session_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx    record;
  v_target int;
  v_loc    game.final_locations%rowtype;
begin
  select * into v_ctx from game._team_session(p_session_hash);
  select target_count into v_target from game.events where id = v_ctx.o_event_id;
  if game._found_count(v_ctx.o_team_id) < v_target then
    perform game._fail('final_locked');
  end if;
  select * into v_loc from game.final_locations
  where event_id = v_ctx.o_event_id order by version desc limit 1;
  if not found then
    perform game._fail('final_not_published');
  end if;
  return jsonb_build_object(
    'lat', v_loc.lat, 'lng', v_loc.lng, 'accuracy_m', v_loc.accuracy_m,
    'reference', v_loc.reference, 'version', v_loc.version, 'updated_at', v_loc.created_at);
end
$$;

-- =====================================================================
-- STAFF
-- =====================================================================

-- Devuelve id y hash de contraseña para verificar argon2id en el servidor.
create or replace function game.staff_login_lookup(p_event_slug text, p_username text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res jsonb;
begin
  if p_event_slug !~ '^[a-z0-9-]{1,40}$' or p_username !~ '^[a-z0-9_.-]{3,32}$' then
    return null;
  end if;
  select jsonb_build_object('staff_id', st.id, 'password_hash', st.password_hash)
    into v_res
  from game.staff st join game.events e on e.id = st.event_id
  where e.slug = p_event_slug and st.username = p_username and st.is_active;
  return v_res;
end
$$;

create or replace function game.staff_state(p_session_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_staff game.staff%rowtype;
  v_event game.events%rowtype;
begin
  select * into v_ctx from game._staff_session(p_session_hash, null);
  select * into v_staff from game.staff where id = v_ctx.o_staff_id;
  select * into v_event from game.events where id = v_ctx.o_event_id;
  return jsonb_build_object(
    'staff', jsonb_build_object('username', v_staff.username, 'display_name', v_staff.display_name,
                                'roles', to_jsonb(v_ctx.o_roles)),
    'event', jsonb_build_object('name', v_event.name, 'slug', v_event.slug,
                                'status', v_event.status, 'target', v_event.target_count, 'is_test', v_event.is_test));
end
$$;

create or replace function game.staff_login_create(p_staff_id uuid, p_session_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_event uuid;
begin
  perform game._check_hash(p_session_hash);
  select event_id into v_event from game.staff where id = p_staff_id and is_active;
  if not found then
    perform game._fail('session_invalid');
  end if;
  insert into game.sessions (event_id, token_hash, kind, staff_id, expires_at)
  values (v_event, p_session_hash, 'staff', p_staff_id, now() + interval '14 hours');
  perform game._audit(v_event, 'staff', p_staff_id, 'staff_login', null);
  return game.staff_state(p_session_hash);
end
$$;

create or replace function game.staff_logout(p_session_hash text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform game._check_hash(p_session_hash);
  update game.sessions set revoked_at = now(), revoked_reason = 'logout'
  where token_hash = p_session_hash and kind = 'staff' and revoked_at is null;
end
$$;

-- ---------------------------------------------------------------------
-- Organizador final
-- ---------------------------------------------------------------------
create or replace function game.final_publish_location(
  p_session_hash text, p_lat double precision, p_lng double precision,
  p_accuracy_m double precision, p_reference text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx     record;
  v_version int;
  v_loc     game.final_locations%rowtype;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['final', 'admin']);
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180
     or (p_accuracy_m is not null and (p_accuracy_m < 0 or p_accuracy_m > 100000))
     or p_reference is null or char_length(btrim(p_reference)) not between 1 and 300 then
    perform game._fail('bad_request');
  end if;

  perform 1 from game.events where id = v_ctx.o_event_id for update;
  select coalesce(max(version), 0) + 1 into v_version
  from game.final_locations where event_id = v_ctx.o_event_id;

  insert into game.final_locations (event_id, version, lat, lng, accuracy_m, reference, created_by)
  values (v_ctx.o_event_id, v_version, p_lat, p_lng, p_accuracy_m, btrim(p_reference), v_ctx.o_staff_id)
  returning * into v_loc;

  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'final_location_publish', null,
                      jsonb_build_object('version', v_version));
  return jsonb_build_object('lat', v_loc.lat, 'lng', v_loc.lng, 'accuracy_m', v_loc.accuracy_m,
                            'reference', v_loc.reference, 'version', v_loc.version, 'updated_at', v_loc.created_at);
end
$$;

create or replace function game.final_current_location(p_session_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx record;
  v_loc game.final_locations%rowtype;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['final', 'admin']);
  select * into v_loc from game.final_locations
  where event_id = v_ctx.o_event_id order by version desc limit 1;
  if not found then
    return null;
  end if;
  return jsonb_build_object('lat', v_loc.lat, 'lng', v_loc.lng, 'accuracy_m', v_loc.accuracy_m,
                            'reference', v_loc.reference, 'version', v_loc.version, 'updated_at', v_loc.created_at);
end
$$;

create or replace function game._staff_team_view(p_team game.teams) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_target int;
  v_found  int;
  v_finish jsonb;
begin
  select target_count into v_target from game.events where id = p_team.event_id;
  v_found := game._found_count(p_team.id);
  select jsonb_build_object('rank', game._finish_rank(f.id), 'position', f.position,
                            'confirmed_at', f.confirmed_at, 'voided', f.voided_at is not null)
    into v_finish
  from game.finishes f where f.team_id = p_team.id;
  return jsonb_build_object(
    'public_id', p_team.public_id, 'name', p_team.name, 'status', p_team.status,
    'found_count', v_found, 'target', v_target,
    'eligible', p_team.status = 'active' and v_found >= v_target,
    'finish', v_finish);
end
$$;

create or replace function game.final_lookup(p_session_hash text, p_public_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx  record;
  v_team game.teams%rowtype;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['final', 'admin']);
  select * into v_team from game.teams
  where event_id = v_ctx.o_event_id and public_id = upper(btrim(p_public_id));
  if not found then
    perform game._fail('team_not_found');
  end if;
  return game._staff_team_view(v_team);
end
$$;

-- Confirma presencialmente la llegada. El orden se asigna en serie
-- bloqueando la fila del evento; repetir devuelve la llegada existente.
create or replace function game.final_confirm(p_session_hash text, p_public_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx     record;
  v_status  game.event_status;
  v_target  int;
  v_team    game.teams%rowtype;
  v_finish  game.finishes%rowtype;
  v_pos     int;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['final']);

  select status, target_count into v_status, v_target
  from game.events where id = v_ctx.o_event_id for update;

  select * into v_team from game.teams
  where event_id = v_ctx.o_event_id and public_id = upper(btrim(p_public_id))
  for update;
  if not found then
    perform game._fail('team_not_found');
  end if;

  select * into v_finish from game.finishes where team_id = v_team.id;
  if found then
    if v_finish.voided_at is not null then
      perform game._fail('finish_voided');
    end if;
    return jsonb_build_object('result', 'already_confirmed', 'team', game._staff_team_view(v_team));
  end if;

  if v_status <> 'running' then
    perform game._fail('event_not_running');
  end if;
  if v_ctx.o_team_id is not null and v_ctx.o_team_id = v_team.id then
    perform game._fail('own_team_forbidden');
  end if;
  if v_team.status <> 'active' or game._found_count(v_team.id) < v_target then
    perform game._fail('not_eligible');
  end if;

  select coalesce(max(position), 0) + 1 into v_pos
  from game.finishes where event_id = v_ctx.o_event_id;

  insert into game.finishes (event_id, team_id, position, confirmed_by)
  values (v_ctx.o_event_id, v_team.id, v_pos, v_ctx.o_staff_id);

  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'finish_confirm', v_team.id,
                      jsonb_build_object('position', v_pos));
  return jsonb_build_object('result', 'confirmed', 'team', game._staff_team_view(v_team));
end
$$;

-- =====================================================================
-- ADMINISTRACIÓN
-- =====================================================================
create or replace function game._check_reason(p_reason text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    perform game._fail('reason_required');
  end if;
  return btrim(p_reason);
end
$$;

create or replace function game._admin_team(p_event_id uuid, p_public_id text) returns game.teams
language plpgsql set search_path = '' as $$
declare
  v_team game.teams%rowtype;
begin
  select * into v_team from game.teams
  where event_id = p_event_id and public_id = upper(btrim(p_public_id))
  for update;
  if not found then
    perform game._fail('team_not_found');
  end if;
  return v_team;
end
$$;

create or replace function game.admin_overview(p_session_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx   record;
  v_event game.events%rowtype;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  select * into v_event from game.events where id = v_ctx.o_event_id;

  return jsonb_build_object(
    'event', jsonb_build_object('name', v_event.name, 'slug', v_event.slug, 'status', v_event.status,
                                'target', v_event.target_count, 'is_test', v_event.is_test),
    'qr_points', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', q.slug, 'public_name', q.public_name, 'is_active', q.is_active,
               'clues', (select count(*) from game.clues c where c.target_qr_id = q.id and c.is_active),
               'pointed_by', (select count(*) from game.team_pointer p where p.target_qr_id = q.id),
               'found_by', (select count(*) from game.team_scans s where s.qr_point_id = q.id and s.voided_at is null))
             order by q.sort_order, q.slug)
      from game.qr_points q where q.event_id = v_event.id), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(
               game._staff_team_view(t) || jsonb_build_object(
                 'found', coalesce((
                    select jsonb_agg(jsonb_build_object('slug', q.slug, 'scanned_at', s.scanned_at, 'source', s.source)
                                     order by s.scanned_at)
                    from game.team_scans s join game.qr_points q on q.id = s.qr_point_id
                    where s.team_id = t.id and s.voided_at is null), '[]'::jsonb),
                 'pointer_slug', (select q.slug from game.team_pointer p join game.qr_points q on q.id = p.target_qr_id
                                  where p.team_id = t.id),
                 'session_active', exists (select 1 from game.sessions s where s.team_id = t.id
                                           and s.revoked_at is null and s.expires_at > now()),
                 'last_scan_at', (select max(s.scanned_at) from game.team_scans s where s.team_id = t.id and s.voided_at is null))
             order by t.public_id)
      from game.teams t where t.event_id = v_event.id), '[]'::jsonb),
    'final_location', game.final_current_location(p_session_hash),
    'server_time', now());
end
$$;

create or replace function game.admin_set_event_status(
  p_session_hash text, p_status text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx record;
  v_old game.event_status;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  if p_status is null or p_status not in ('draft', 'open', 'running', 'paused', 'closed') then
    perform game._fail('bad_request');
  end if;
  select status into v_old from game.events where id = v_ctx.o_event_id for update;
  update game.events set status = p_status::game.event_status where id = v_ctx.o_event_id;
  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'event_status', null,
                      jsonb_build_object('from', v_old, 'to', p_status, 'reason', left(coalesce(p_reason, ''), 500)));
  return jsonb_build_object('status', p_status);
end
$$;

create or replace function game.admin_create_team(
  p_session_hash text, p_public_id text, p_name text, p_members text[]
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx  record;
  v_team game.teams%rowtype;
  v_m    text;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  if coalesce(array_length(p_members, 1), 0) > 8 then
    perform game._fail('bad_request');
  end if;
  begin
    insert into game.teams (event_id, public_id, name)
    values (v_ctx.o_event_id, upper(btrim(p_public_id)), btrim(p_name))
    returning * into v_team;
  exception
    when unique_violation then perform game._fail('team_exists');
    when check_violation then perform game._fail('bad_request');
  end;
  foreach v_m in array coalesce(p_members, '{}') loop
    if char_length(btrim(v_m)) between 1 and 60 then
      insert into game.team_members (event_id, team_id, display_name)
      values (v_ctx.o_event_id, v_team.id, btrim(v_m));
    end if;
  end loop;
  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'team_create', v_team.id,
                      jsonb_build_object('public_id', v_team.public_id));
  return game._staff_team_view(v_team);
end
$$;

create or replace function game.admin_set_team_status(
  p_session_hash text, p_public_id text, p_status text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx    record;
  v_team   game.teams%rowtype;
  v_reason text;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  v_reason := game._check_reason(p_reason);
  if p_status not in ('active', 'disabled') then
    perform game._fail('bad_request');
  end if;
  v_team := game._admin_team(v_ctx.o_event_id, p_public_id);
  update game.teams set status = p_status where id = v_team.id returning * into v_team;
  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'team_status', v_team.id,
                      jsonb_build_object('status', p_status, 'reason', v_reason));
  return game._staff_team_view(v_team);
end
$$;

-- Emite un nuevo código de activación. Revoca códigos sin usar y TODAS las
-- sesiones del equipo (cambio de teléfono). El progreso se conserva.
create or replace function game.admin_issue_activation(
  p_session_hash text, p_public_id text, p_code_hash text, p_ttl_minutes int, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx     record;
  v_team    game.teams%rowtype;
  v_reason  text;
  v_expires timestamptz;
  v_revoked int;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  perform game._check_hash(p_code_hash);
  v_reason := game._check_reason(p_reason);
  if p_ttl_minutes is null or p_ttl_minutes not between 5 and 10080 then
    perform game._fail('bad_request');
  end if;
  v_team := game._admin_team(v_ctx.o_event_id, p_public_id);

  update game.activation_tokens set revoked_at = now()
  where team_id = v_team.id and used_at is null and revoked_at is null;

  update game.sessions set revoked_at = now(), revoked_reason = 'access_transfer'
  where team_id = v_team.id and kind = 'team' and revoked_at is null;
  get diagnostics v_revoked = row_count;

  v_expires := now() + make_interval(mins => p_ttl_minutes);
  insert into game.activation_tokens (event_id, team_id, token_hash, expires_at, created_by)
  values (v_ctx.o_event_id, v_team.id, p_code_hash, v_expires, v_ctx.o_staff_id);

  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'activation_issue', v_team.id,
                      jsonb_build_object('reason', v_reason, 'sessions_revoked', v_revoked, 'expires_at', v_expires));
  return jsonb_build_object('public_id', v_team.public_id, 'expires_at', v_expires, 'sessions_revoked', v_revoked);
end
$$;

-- Alta manual de un QR (respaldo por incidencia). Motivo obligatorio.
create or replace function game.admin_add_scan(
  p_session_hash text, p_public_id text, p_qr_slug text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx    record;
  v_team   game.teams%rowtype;
  v_qr     uuid;
  v_reason text;
  v_id     uuid;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  v_reason := game._check_reason(p_reason);
  v_team := game._admin_team(v_ctx.o_event_id, p_public_id);
  select id into v_qr from game.qr_points where event_id = v_ctx.o_event_id and slug = p_qr_slug;
  if not found then
    perform game._fail('qr_invalid');
  end if;
  insert into game.team_scans (event_id, team_id, qr_point_id, source, created_by, reason)
  values (v_ctx.o_event_id, v_team.id, v_qr, 'admin', v_ctx.o_staff_id, v_reason)
  on conflict (team_id, qr_point_id) where voided_at is null do nothing
  returning id into v_id;
  if v_id is null then
    perform game._fail('already_registered');
  end if;
  perform game._sync_pointer(v_team.id, v_ctx.o_event_id);
  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'scan_add_manual', v_team.id,
                      jsonb_build_object('qr', p_qr_slug, 'reason', v_reason));
  return game._staff_team_view(v_team);
end
$$;

create or replace function game.admin_void_scan(
  p_session_hash text, p_public_id text, p_qr_slug text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx    record;
  v_team   game.teams%rowtype;
  v_reason text;
  v_n      int;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  v_reason := game._check_reason(p_reason);
  v_team := game._admin_team(v_ctx.o_event_id, p_public_id);
  update game.team_scans s set voided_at = now(), voided_by = v_ctx.o_staff_id, void_reason = v_reason
  from game.qr_points q
  where q.id = s.qr_point_id and q.slug = p_qr_slug and q.event_id = v_ctx.o_event_id
    and s.team_id = v_team.id and s.voided_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    perform game._fail('scan_not_found');
  end if;
  perform game._sync_pointer(v_team.id, v_ctx.o_event_id);
  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'scan_void', v_team.id,
                      jsonb_build_object('qr', p_qr_slug, 'reason', v_reason));
  return game._staff_team_view(v_team);
end
$$;

create or replace function game.admin_void_finish(
  p_session_hash text, p_public_id text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx    record;
  v_team   game.teams%rowtype;
  v_reason text;
  v_n      int;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  v_reason := game._check_reason(p_reason);
  perform 1 from game.events where id = v_ctx.o_event_id for update;
  v_team := game._admin_team(v_ctx.o_event_id, p_public_id);
  update game.finishes set voided_at = now(), voided_by = v_ctx.o_staff_id, void_reason = v_reason
  where team_id = v_team.id and voided_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    perform game._fail('finish_not_found');
  end if;
  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'finish_void', v_team.id,
                      jsonb_build_object('reason', v_reason));
  return game._staff_team_view(v_team);
end
$$;

create or replace function game.admin_audit(p_session_hash text, p_limit int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx record;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc)
    from (
      select a.created_at, a.actor_kind, a.action, a.details,
             coalesce(st.username, tm.public_id) as actor, t.public_id as team
      from game.audit_log a
      left join game.staff st on a.actor_kind = 'staff' and st.id = a.actor_id
      left join game.teams tm on a.actor_kind = 'team' and tm.id = a.actor_id
      left join game.teams t on t.id = a.team_id
      where a.event_id = v_ctx.o_event_id
      order by a.created_at desc
      limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) x), '[]'::jsonb);
end
$$;
