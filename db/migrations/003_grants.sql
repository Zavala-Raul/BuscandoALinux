-- =====================================================================
-- 003_grants.sql — Permisos mínimos.
-- rally_app: USAGE en el esquema y EXECUTE solo en las funciones públicas.
-- Sin privilegios sobre tablas, secuencias ni funciones internas (_*).
-- =====================================================================

revoke all on schema game from public;
revoke all on all tables    in schema game from public;
revoke all on all sequences in schema game from public;
revoke all on all functions in schema game from public;

alter default privileges in schema game revoke all on tables    from public;
alter default privileges in schema game revoke all on sequences from public;
alter default privileges in schema game revoke all on functions from public;

grant usage on schema game to rally_app;
revoke all on all tables    in schema game from rally_app;
revoke all on all sequences in schema game from rally_app;
revoke all on all functions in schema game from rally_app;

grant execute on function
  game.rate_hit(text, int, int),
  game.activate_team(text, text, text),
  game.get_my_state(text),
  game.scan_qr(text, text),
  game.get_final_location(text),
  game.staff_login_lookup(text, text),
  game.staff_login_create(uuid, text),
  game.staff_state(text),
  game.staff_logout(text),
  game.final_publish_location(text, double precision, double precision, double precision, text),
  game.final_current_location(text),
  game.final_lookup(text, text),
  game.final_confirm(text, text),
  game.admin_overview(text),
  game.admin_set_event_status(text, text, text),
  game.admin_create_team(text, text, text, text[]),
  game.admin_set_team_status(text, text, text, text),
  game.admin_issue_activation(text, text, text, int, text),
  game.admin_add_scan(text, text, text, text),
  game.admin_void_scan(text, text, text, text),
  game.admin_void_finish(text, text, text),
  game.admin_audit(text, int)
to rally_app;
