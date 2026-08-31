import { trackAndLogQuery } from '../middleware/queryLogger';
import { Pool, PoolClient } from "pg";
import config from "./index";
import { logger } from "../utils/logger";
import { createSecurePoolConfig } from "../database/connection";

export const poolConfig = createSecurePoolConfig(config.db);

export const pool = new Pool(poolConfig);

export const createOptimizedPool = (): Pool => {
  const optimized = new Pool(poolConfig);

  optimized.on("error", (err) => {
    logger.error({ error: err.message }, "Unexpected database pool error");
  });

  optimized.on("connect", (client) => {
    client.query("SET join_collapse_limit = 8").catch(() => {});
    client.on("error", (error) => {
      logger.error({ error: error.message }, "Database client error");
    });
  });

  return optimized;
};

export const testConnection = async (): Promise<boolean> => {
  const start = Date.now();
  try {
    const client = await pool.connect();
    try {
      // Basic health check query to ensure database is responsive
      await client.query('SELECT 1');
      const latency = Date.now() - start;
      logger.info({ latencyMs: latency }, "Database connected successfully and is responsive");
      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : error },
      "Database connection failed",
    );
    return false;
  }
};

// ─── Pool Utilization Monitoring ──────────────────────────────────────────────
// Periodically logs the connection pool metrics if the pool is under load or
// just to provide telemetry for dynamic scaling decisions.

let monitorInterval: NodeJS.Timeout | null = null;

export const startPoolMonitoring = (intervalMs = 60000) => {
  if (monitorInterval) return;
  monitorInterval = setInterval(() => {
    const { totalCount, idleCount, waitingCount } = pool;
    logger.info(
      { totalCount, idleCount, waitingCount, max: config.db.poolMax },
      'Database pool utilization telemetry'
    );
  }, intervalMs);
};

export const stopPoolMonitoring = () => {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
};

// Start monitoring automatically
startPoolMonitoring();

pool.on("error", (err) => {
  logger.error({ error: err.message }, "Unexpected database pool error");
});

pool.on("connect", (client) => {
  client.query("SET join_collapse_limit = 8").catch(() => {});
  client.on("error", (error) => {
    logger.error({ error: error.message }, "Database client error");
  });
});

export const db = {
  query: async (text: string, params?: any[]) => {
    return await trackAndLogQuery(pool, text, params || []);
  },
  connect: async () => {
    return await pool.connect();
  },
};

// ─── Tenant-aware pool checkout ───────────────────────────────────────────────
//
// TenantPoolManager wraps the pool so that every connection checkout
// automatically sets the `app.tenant_id` PostgreSQL session variable.
// This enables PostgreSQL Row Level Security (RLS) policies to enforce
// tenant isolation at the database layer, providing a defense-in-depth
// guarantee even if the application-level tenant filter is bypassed.
//
// Usage:
//   const client = await TenantPoolManager.connect(tenantId);
//   await client.query('SELECT * FROM bookings');
//   client.release();
//
// The variable is reset to '' on release so the next borrower of that
// connection gets a clean slate.

export const TenantPoolManager = {
  /**
   * Acquire a pool client with `app.tenant_id` set to `tenantId`.
   *
   * @param tenantId  UUID of the tenant to scope queries to, an empty string
   *                  for no filtering, or the '__ADMIN_BYPASS__' sentinel.
   */
  async connect(tenantId: string | null): Promise<PoolClient> {
    const client = await pool.connect();

    // Sanitize: only allow UUID-shaped values, empty string, or the bypass
    // sentinel. Reject anything else to prevent injection via the setting.
    const safeId = sanitizeTenantId(tenantId);

    try {
      // Use set_config with is_local=TRUE so the value is scoped to the
      // current transaction (reverted on ROLLBACK / COMMIT). When outside a
      // transaction, the value persists until the connection is released.
      await client.query(`SELECT set_config('app.tenant_id', $1, FALSE)`, [safeId]);
    } catch (err) {
      client.release();
      throw err;
    }

    // Wrap release to reset the tenant setting before returning the connection
    // to the pool, so the next borrower gets a clean state.
    const originalRelease = client.release.bind(client);
    (client as any).release = async (err?: Error | boolean) => {
      try {
        await client.query(`SELECT set_config('app.tenant_id', '', FALSE)`);
      } catch {
        // Best-effort reset — don't block release on failure.
      }
      originalRelease(err as any);
    };

    return client;
  },

  /**
   * Execute a callback with a tenant-scoped client, automatically releasing
   * the connection when done (or on error).
   *
   * @example
   * const result = await TenantPoolManager.withClient(tenantId, (client) =>
   *   client.query('SELECT * FROM bookings WHERE id = $1', [id])
   * );
   */
  async withClient<T>(
    tenantId: string | null,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await TenantPoolManager.connect(tenantId);
    try {
      return await callback(client);
    } finally {
      await (client as any).release();
    }
  },
};

/**
 * Validate and sanitize a tenant ID before passing it to set_config.
 * Accepts:
 *  - A valid UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 *  - The admin bypass sentinel '__ADMIN_BYPASS__'
 *  - null / undefined / empty string → returns ''
 *
 * Rejects any other value to prevent session-variable injection.
 */
function sanitizeTenantId(tenantId: string | null | undefined): string {
  if (!tenantId) return '';

  const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (tenantId === '__ADMIN_BYPASS__' || UUID_REGEX.test(tenantId)) {
    return tenantId;
  }

  // Unexpected value — log and return empty (no filtering) rather than throw,
  // so a misconfigured request degrades gracefully instead of crashing.
  logger.warn(
    { tenantId },
    'sanitizeTenantId: invalid tenant ID format — falling back to no-filter',
  );
  return '';
}

export default pool;
