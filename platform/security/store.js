const { TtlStore } = require('../../shared/src/ttlStore');

/**
 * The security layer's own store.
 *
 * The class moved to shared/src/ttlStore.js so the Redis cache can use the same
 * implementation without shared/ having to require up into platform/. It is
 * re-exported here because every filter in this directory imports { TtlStore,
 * store } from this path.
 *
 * This singleton stays SEPARATE from the cache's store on purpose: rate-limit
 * counters are attacker-influenced and capped accordingly, and they must not
 * compete for the same eviction budget as cached permissions — a spray of
 * forged IPs should never be able to flush the authorisation cache.
 */
const store = new TtlStore();

module.exports = { TtlStore, store };
