const { TtlStore } = require('./ttlStore');

/**
 * One cache for the whole backend: Redis when it is there, in-process when it
 * is not.
 *
 * Redis has been in docker-compose and REDIS_URL has been documented since this
 * repo was split, but no client was installed and nothing read it — so every
 * request re-read the same permissions and settings from MySQL.
 *
 * ── The availability rule ────────────────────────────────────────────────────
 *
 * An unreachable Redis must NEVER fail a request. Every operation here degrades
 * to the in-process store, and a read that misses degrades to the database —
 * which is exactly what the code did before this existed. A cache that can take
 * the API down is worse than no cache, so there is no path in this file that
 * propagates a Redis error to a caller.
 *
 * The consequence of the fallback is stated rather than hidden: with several
 * instances and no Redis, each keeps its own copy, so an eviction on one is not
 * seen by the others until the TTL lapses. That is why the TTLs below are short
 * even though eviction is explicit.
 */

/**
 * Bumped when a cached SHAPE changes.
 *
 * Deploying code that reads a different structure out of a key than the running
 * version wrote into it is the classic cache bug: the old value is still valid
 * to Redis and nonsense to the new code. Changing this prefix retires every old
 * key at once without a flush.
 */
const CACHE_VERSION = 'v1';

/** Namespaces, so a prefix eviction cannot reach further than intended. */
const KEYS = {
  userPermissions: (userId) => `perm:user:${userId}`,
  userRoles: (userId) => `roles:user:${userId}`,
  settings: (group, companyId) => `settings:${group}:${companyId ?? 'global'}`,
  notificationConfig: (companyId) => `notify-config:${companyId ?? 'platform'}`,
  /**
   * Recipients of an event, keyed by company AND the permission set.
   *
   * The names are sorted before they reach here so that ['a','b'] and ['b','a']
   * are one cache entry rather than two views of the same answer.
   */
  permissionRecipients: (companyId, names) =>
    `recipients:${companyId ?? 'platform'}:${[...names].sort().join(',')}`,
  installmentPlansForUnit: (unitId) => `plans:unit:${unitId}`,
};

/**
 * How long each kind of thing may be stale.
 *
 * Authorisation is deliberately the SHORTEST. Eviction on write is the primary
 * mechanism, but a TTL is the backstop for the cases eviction cannot cover — a
 * row changed by a migration, by another deployment, or by hand in the
 * database — and for authorisation the cost of being wrong is someone keeping
 * access they should have lost.
 */
const TTL = {
  authorisation: 300,        // 5 minutes
  settings: 600,             // 10 minutes
  notificationConfig: 600,
  reference: 1800,           // installment plans and similar
};

const isDisabled = () => String(process.env.CACHE_ENABLED ?? 'true').toLowerCase() === 'false';

const createCache = () => {
  const prefix = `${process.env.CACHE_PREFIX || 'realx8'}:${CACHE_VERSION}:`;
  const fallback = new TtlStore({ maxEntries: 20_000 });

  let redis = null;
  let redisReady = false;

  /**
   * Connects lazily and never throws.
   *
   * `retryStrategy` returning null stops ioredis reconnecting forever in an
   * environment that simply has no Redis — otherwise a local dev machine logs a
   * connection error every few hundred milliseconds for the life of the
   * process.
   */
  const connect = () => {
    if (redis || isDisabled() || !process.env.REDIS_URL) return;
    try {
      // eslint-disable-next-line global-require
      const Redis = require('ioredis');
      redis = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: (attempts) => (attempts > 5 ? null : Math.min(attempts * 200, 2000)),
      });
      redis.on('ready', () => {
        redisReady = true;
        console.log('[cache] redis connected');
      });
      redis.on('end', () => { redisReady = false; });
      redis.on('error', (error) => {
        // Logged once per transition, not per failed command.
        if (redisReady) console.error('[cache] redis error:', error.message);
        redisReady = false;
      });
      redis.connect().catch((error) => {
        console.warn(`[cache] redis unavailable (${error.message.split('\n')[0]}) — `
          + 'using the in-process cache. Reads fall through to the database.');
      });
    } catch (error) {
      console.warn('[cache] ioredis not available — using the in-process cache:', error.message);
      redis = null;
    }
  };

  connect();

  const key = (name) => `${prefix}${name}`;

  const get = async (name) => {
    if (isDisabled()) return null;
    const full = key(name);
    if (redisReady) {
      try {
        const raw = await redis.get(full);
        return raw === null ? null : JSON.parse(raw);
      } catch (error) {
        console.error('[cache] get failed, falling through:', error.message);
      }
    }
    return fallback.get(full);
  };

  const set = async (name, value, ttlSeconds) => {
    if (isDisabled()) return value;
    const full = key(name);
    // Written to BOTH, so a Redis outage mid-request does not lose the value
    // the caller just computed.
    fallback.set(full, value, ttlSeconds);
    if (redisReady) {
      try {
        await redis.set(full, JSON.stringify(value), 'EX', ttlSeconds);
      } catch (error) {
        console.error('[cache] set failed, kept in-process only:', error.message);
      }
    }
    return value;
  };

  const del = async (...names) => {
    const fullKeys = names.flat().filter(Boolean).map(key);
    if (!fullKeys.length) return;
    fullKeys.forEach((full) => fallback.delete(full));
    if (redisReady) {
      try {
        await redis.del(...fullKeys);
      } catch (error) {
        console.error('[cache] del failed:', error.message);
      }
    }
  };

  /**
   * Evicts everything under a prefix.
   *
   * SCAN, never KEYS: KEYS walks the entire keyspace in one blocking call, and
   * on a production Redis that is a stall long enough to time out every other
   * client. SCAN pages through instead.
   */
  const delByPrefix = async (namePrefix) => {
    const match = `${key(namePrefix)}*`;
    for (const [full] of fallback.entries) {
      if (full.startsWith(key(namePrefix))) fallback.delete(full);
    }
    if (!redisReady) return;
    try {
      let cursor = '0';
      do {
        // eslint-disable-next-line no-await-in-loop
        const [next, batch] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 200);
        cursor = next;
        // eslint-disable-next-line no-await-in-loop
        if (batch.length) await redis.del(...batch);
      } while (cursor !== '0');
    } catch (error) {
      console.error('[cache] prefix eviction failed:', error.message);
    }
  };

  /**
   * Read-through: cached value, or run the loader and cache what it returns.
   *
   * A loader that throws is NOT cached — otherwise one database blip would be
   * remembered as an answer for the whole TTL. `null`/`undefined` is likewise
   * not cached, so "this user has no permissions yet" is re-asked rather than
   * pinned.
   */
  const wrap = async (name, ttlSeconds, loader) => {
    const cached = await get(name);
    if (cached !== null && cached !== undefined) return cached;

    const value = await loader();
    if (value !== null && value !== undefined) await set(name, value, ttlSeconds);
    return value;
  };

  const stats = () => ({
    backend: redisReady ? 'redis' : 'in-process',
    enabled: !isDisabled(),
    inProcessEntries: fallback.size,
    prefix,
  });

  const disconnect = async () => {
    if (redis) {
      try { await redis.quit(); } catch { /* already gone */ }
    }
  };

  return { get, set, del, delByPrefix, wrap, stats, disconnect, KEYS, TTL };
};

/** One instance per process, so every caller shares the same connection. */
const cache = createCache();

module.exports = { cache, createCache, KEYS, TTL, CACHE_VERSION };
