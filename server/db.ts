/**
 * Pool de conexión a PostgreSQL con el rol restringido rally_app.
 * Expone únicamente llamadas parametrizadas a funciones del esquema game.
 */
import pg from 'pg';

export class GameError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

let defaultPool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!defaultPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL no está definido');
    }
    defaultPool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 8_000,
    });
  }
  return defaultPool;
}

export async function closePool(): Promise<void> {
  if (defaultPool) {
    await defaultPool.end();
    defaultPool = null;
  }
}

export interface DbCaller {
  call<T = unknown>(fnName: string, args?: unknown[]): Promise<T>;
}

const SAFE_FN_NAME = /^[a-z_][a-z0-9_]*$/;

export function createDbCaller(pool: pg.Pool = getPool()): DbCaller {
  return {
    async call<T = unknown>(fnName: string, args: unknown[] = []): Promise<T> {
      if (!SAFE_FN_NAME.test(fnName)) {
        throw new Error(`Nombre de función inválido: ${fnName}`);
      }
      const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `select game.${fnName}(${placeholders}) as res`;
      try {
        const res = await pool.query<{ res: T }>(sql, args);
        return res.rows[0]?.res as T;
      } catch (err) {
        const pgErr = err as { code?: string; message?: string };
        if (pgErr && pgErr.code === 'GX000' && typeof pgErr.message === 'string') {
          throw new GameError(pgErr.message);
        }
        throw err;
      }
    },
  };
}
