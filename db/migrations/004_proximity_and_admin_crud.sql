-- =====================================================================
-- 004_proximity_and_admin_crud.sql
-- 1) Coordenadas opcionales y radio de cercanía en estaciones QR (qr_points).
-- 2) Radar de cercanía para equipos (game.check_proximity) sin exponer
--    coordenadas ni distancias exactas al navegador.
-- 3) Gestión completa desde el panel /admin: configurar meta de QRs
--    (target_count), crear/editar/eliminar estaciones QR con coordenadas,
--    agregar/eliminar pistas, eliminar equipos y limpiar datos de prueba.
-- =====================================================================

alter table game.qr_points
  add column if not exists lat double precision check (lat is null or (lat between -90 and 90)),
  add column if not exists lng double precision check (lng is null or (lng between -180 and 180)),
  add column if not exists proximity_radius_m int not null default 35 check (proximity_radius_m between 10 and 500);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'qr_points_coords_pair'
  ) then
    alter table game.qr_points
      add constraint qr_points_coords_pair check ((lat is null) = (lng is null));
  end if;
end
$$;

-- Distancia Haversine en metros entre dos coordenadas WGS84.
create or replace function game._distance_m(
  p_lat1 double precision, p_lng1 double precision,
  p_lat2 double precision, p_lng2 double precision
) returns double precision
language sql immutable set search_path = '' as $$
  select 2.0 * 6371000.0 * asin(least(1.0, sqrt(
    pow(sin(radians((p_lat2 - p_lat1) / 2.0)), 2) +
    cos(radians(p_lat1)) * cos(radians(p_lat2)) *
    pow(sin(radians((p_lng2 - p_lng1) / 2.0)), 2)
  )));
$$;

-- Actualiza _team_state para informar si existen estaciones pendientes con coordenadas
-- (proximity_enabled), sin revelar nunca cuáles ni dónde están.
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
  v_prox    boolean := false;
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

    select exists (
      select 1 from game.qr_points q
      where q.event_id = v_event.id
        and q.is_active
        and q.lat is not null
        and q.lng is not null
        and not exists (
          select 1 from game.team_scans s
          where s.team_id = p_team_id and s.qr_point_id = q.id and s.voided_at is null
        )
    ) into v_prox;
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
    'proximity_enabled', v_prox,
    'final',  v_final,
    'finish', v_finish,
    'server_time', now()
  );
end
$$;

-- Comprueba si el equipo está cerca de una estación QR pendiente.
-- Nunca devuelve coordenadas, nombres ni distancias en metros.
create or replace function game.check_proximity(
  p_session_hash text,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx         record;
  v_status      game.event_status;
  v_ptr_qr      uuid;
  v_tolerance   double precision;
  v_best_zone   text := 'no_coords';
  v_near_target boolean := false;
  v_rec         record;
  v_eff_dist    double precision;
begin
  select * into v_ctx from game._team_session(p_session_hash);

  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    perform game._fail('bad_request');
  end if;

  select status into v_status from game.events where id = v_ctx.o_event_id;
  if v_status <> 'running' then
    perform game._fail('event_not_running');
  end if;

  select target_qr_id into v_ptr_qr from game.team_pointer where team_id = v_ctx.o_team_id;

  -- Margen prudente por imprecisión de GPS (máximo 15 m para no regalar cercanía).
  v_tolerance := least(greatest(coalesce(p_accuracy_m, 0.0) * 0.4, 0.0), 15.0);

  for v_rec in
    select q.id, q.lat, q.lng, q.proximity_radius_m
    from game.qr_points q
    where q.event_id = v_ctx.o_event_id
      and q.is_active
      and q.lat is not null
      and q.lng is not null
      and not exists (
        select 1 from game.team_scans s
        where s.team_id = v_ctx.o_team_id and s.qr_point_id = q.id and s.voided_at is null
      )
  loop
    if v_best_zone = 'no_coords' then
      v_best_zone := 'far';
    end if;

    v_eff_dist := greatest(0.0, game._distance_m(p_lat, p_lng, v_rec.lat, v_rec.lng) - v_tolerance);

    if v_eff_dist <= v_rec.proximity_radius_m then
      v_best_zone := 'near';
      if v_ptr_qr is not null and v_rec.id = v_ptr_qr then
        v_near_target := true;
      end if;
    elsif v_eff_dist <= (v_rec.proximity_radius_m * 2.2) and v_best_zone <> 'near' then
      v_best_zone := 'approaching';
      if v_ptr_qr is not null and v_rec.id = v_ptr_qr then
        v_near_target := true;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'zone', v_best_zone,
    'near', (v_best_zone = 'near'),
    'is_target', v_near_target,
    'checked_at', now()
  );
end
$$;

-- =====================================================================
-- FUNCIONES DE ADMINISTRACIÓN PARA GESTIONAR ESTACIONES, PISTAS Y EVENTO
-- =====================================================================

-- Actualiza admin_overview para incluir coordenadas, código QR y lista de pistas de cada estación.
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
               'slug', q.slug,
               'public_name', q.public_name,
               'code', q.code,
               'sort_order', q.sort_order,
               'is_active', q.is_active,
               'lat', q.lat,
               'lng', q.lng,
               'proximity_radius_m', q.proximity_radius_m,
               'clues', (select count(*) from game.clues c where c.target_qr_id = q.id and c.is_active),
               'clues_list', coalesce((
                 select jsonb_agg(jsonb_build_object('id', c.id, 'body', c.body, 'is_active', c.is_active) order by c.created_at)
                 from game.clues c where c.target_qr_id = q.id and c.is_active
               ), '[]'::jsonb),
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

-- Configurar nombre del evento, cantidad de QRs requeridos (target_count) y bandera is_test.
create or replace function game.admin_update_event(
  p_session_hash text, p_name text, p_target_count int, p_is_test boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx  record;
  v_team record;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120
     or p_target_count is null or p_target_count not between 1 and 50 then
    perform game._fail('bad_request');
  end if;

  update game.events
     set name = btrim(p_name),
         target_count = p_target_count,
         is_test = coalesce(p_is_test, false)
   where id = v_ctx.o_event_id;

  for v_team in select id from game.teams where event_id = v_ctx.o_event_id loop
    perform game._sync_pointer(v_team.id, v_ctx.o_event_id);
  end loop;

  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'event_config_update', null,
                      jsonb_build_object('name', btrim(p_name), 'target_count', p_target_count, 'is_test', coalesce(p_is_test, false)));

  return jsonb_build_object('name', btrim(p_name), 'target', p_target_count, 'is_test', coalesce(p_is_test, false));
end
$$;

-- Crear o actualizar una estación QR (con coordenadas opcionales y radio de cercanía).
create or replace function game.admin_upsert_qr_point(
  p_session_hash text,
  p_slug text,
  p_public_name text,
  p_code text,
  p_sort_order int,
  p_is_active boolean,
  p_lat double precision,
  p_lng double precision,
  p_proximity_radius_m int
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx  record;
  v_qr   game.qr_points%rowtype;
  v_team record;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);

  if p_slug is null or p_slug !~ '^[a-z0-9-]{1,40}$'
     or p_public_name is null or char_length(btrim(p_public_name)) not between 1 and 80
     or ((p_lat is null) <> (p_lng is null))
     or (p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180))
     or coalesce(p_proximity_radius_m, 35) not between 10 and 500
  then
    perform game._fail('bad_request');
  end if;

  select * into v_qr from game.qr_points
  where event_id = v_ctx.o_event_id and slug = p_slug
  for update;

  if found then
    update game.qr_points
       set public_name = btrim(p_public_name),
           sort_order = coalesce(p_sort_order, v_qr.sort_order),
           is_active = coalesce(p_is_active, v_qr.is_active),
           lat = p_lat,
           lng = p_lng,
           proximity_radius_m = coalesce(p_proximity_radius_m, v_qr.proximity_radius_m)
     where id = v_qr.id
     returning * into v_qr;
  else
    if p_code is null or p_code !~ '^[A-Za-z0-9]{22,64}$' then
      perform game._fail('bad_request');
    end if;
    insert into game.qr_points (
      event_id, code, slug, public_name, sort_order, is_active, lat, lng, proximity_radius_m
    )
    values (
      v_ctx.o_event_id, p_code, p_slug, btrim(p_public_name),
      coalesce(p_sort_order, 0), coalesce(p_is_active, true),
      p_lat, p_lng, coalesce(p_proximity_radius_m, 35)
    )
    returning * into v_qr;
  end if;

  for v_team in select id from game.teams where event_id = v_ctx.o_event_id loop
    perform game._sync_pointer(v_team.id, v_ctx.o_event_id);
  end loop;

  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'qr_point_upsert', null,
                      jsonb_build_object('slug', v_qr.slug, 'has_coords', v_qr.lat is not null));

  return jsonb_build_object(
    'slug', v_qr.slug, 'public_name', v_qr.public_name, 'code', v_qr.code,
    'sort_order', v_qr.sort_order, 'is_active', v_qr.is_active,
    'lat', v_qr.lat, 'lng', v_qr.lng, 'proximity_radius_m', v_qr.proximity_radius_m
  );
end
$$;

-- Eliminar una estación QR y resincronizar apuntadores.
create or replace function game.admin_delete_qr_point(
  p_session_hash text, p_slug text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx    record;
  v_reason text;
  v_n      int;
  v_team   record;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  v_reason := game._check_reason(p_reason);

  delete from game.qr_points where event_id = v_ctx.o_event_id and slug = p_slug;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    perform game._fail('qr_invalid');
  end if;

  for v_team in select id from game.teams where event_id = v_ctx.o_event_id loop
    perform game._sync_pointer(v_team.id, v_ctx.o_event_id);
  end loop;

  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'qr_point_delete', null,
                      jsonb_build_object('slug', p_slug, 'reason', v_reason));
  return jsonb_build_object('deleted', p_slug);
end
$$;

-- Agregar una pista a una estación QR.
create or replace function game.admin_add_clue(
  p_session_hash text, p_qr_slug text, p_body text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx  record;
  v_qr   uuid;
  v_clue game.clues%rowtype;
  v_team record;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  if p_body is null or char_length(btrim(p_body)) not between 3 and 1000 then
    perform game._fail('bad_request');
  end if;

  select id into v_qr from game.qr_points where event_id = v_ctx.o_event_id and slug = p_qr_slug;
  if not found then
    perform game._fail('qr_invalid');
  end if;

  insert into game.clues (event_id, target_qr_id, body, is_active)
  values (v_ctx.o_event_id, v_qr, btrim(p_body), true)
  returning * into v_clue;

  for v_team in select id from game.teams where event_id = v_ctx.o_event_id loop
    perform game._sync_pointer(v_team.id, v_ctx.o_event_id);
  end loop;

  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'clue_add', null,
                      jsonb_build_object('qr_slug', p_qr_slug, 'clue_id', v_clue.id));

  return jsonb_build_object('id', v_clue.id, 'body', v_clue.body, 'qr_slug', p_qr_slug);
end
$$;

-- Eliminar una pista y reasignar apuntadores que dependieran de ella.
create or replace function game.admin_delete_clue(
  p_session_hash text, p_clue_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx  record;
  v_n    int;
  v_team record;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  delete from game.clues where event_id = v_ctx.o_event_id and id = p_clue_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    perform game._fail('bad_request');
  end if;

  for v_team in select id from game.teams where event_id = v_ctx.o_event_id loop
    perform game._sync_pointer(v_team.id, v_ctx.o_event_id);
  end loop;

  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'clue_delete', null,
                      jsonb_build_object('clue_id', p_clue_id));
  return jsonb_build_object('deleted', p_clue_id);
end
$$;

-- Eliminar un equipo individualmente.
create or replace function game.admin_delete_team(
  p_session_hash text, p_public_id text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx    record;
  v_reason text;
  v_team   game.teams%rowtype;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  v_reason := game._check_reason(p_reason);
  v_team := game._admin_team(v_ctx.o_event_id, p_public_id);

  update game.staff set team_id = null where event_id = v_ctx.o_event_id and team_id = v_team.id;
  delete from game.teams where id = v_team.id;

  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'team_delete', null,
                      jsonb_build_object('public_id', v_team.public_id, 'reason', v_reason));
  return jsonb_build_object('deleted', v_team.public_id);
end
$$;

-- Limpiar datos del evento (equipos, sesiones de equipo, escaneos, llegadas, ubicaciones
-- y opcionalmente todas las estaciones QR y pistas) conservando las cuentas de staff.
create or replace function game.admin_reset_event_data(
  p_session_hash text, p_wipe_stations boolean, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ctx    record;
  v_reason text;
begin
  select * into v_ctx from game._staff_session(p_session_hash, array['admin']);
  v_reason := game._check_reason(p_reason);

  update game.staff set team_id = null where event_id = v_ctx.o_event_id;
  delete from game.finishes where event_id = v_ctx.o_event_id;
  delete from game.final_locations where event_id = v_ctx.o_event_id;
  delete from game.team_pointer where event_id = v_ctx.o_event_id;
  delete from game.team_scans where event_id = v_ctx.o_event_id;
  delete from game.sessions where event_id = v_ctx.o_event_id and kind = 'team';
  delete from game.activation_tokens where event_id = v_ctx.o_event_id;
  delete from game.teams where event_id = v_ctx.o_event_id;

  if coalesce(p_wipe_stations, false) then
    delete from game.clues where event_id = v_ctx.o_event_id;
    delete from game.qr_points where event_id = v_ctx.o_event_id;
  end if;

  perform game._audit(v_ctx.o_event_id, 'staff', v_ctx.o_staff_id, 'event_reset_data', null,
                      jsonb_build_object('wipe_stations', coalesce(p_wipe_stations, false), 'reason', v_reason));

  return jsonb_build_object('ok', true, 'wipe_stations', coalesce(p_wipe_stations, false));
end
$$;

-- Permisos de ejecución para rally_app sobre las funciones nuevas.
grant execute on function
  game.check_proximity(text, double precision, double precision, double precision),
  game.admin_update_event(text, text, int, boolean),
  game.admin_upsert_qr_point(text, text, text, text, int, boolean, double precision, double precision, int),
  game.admin_delete_qr_point(text, text, text),
  game.admin_add_clue(text, text, text),
  game.admin_delete_clue(text, uuid),
  game.admin_delete_team(text, text, text),
  game.admin_reset_event_data(text, boolean, text)
to rally_app;
