/**
 * A TTL map: the in-process half of the cache, and the store the security
 * filters keep their counters and device records in.
 *
 * It lives in shared/ rather than platform/ because both the cache (shared) and
 * the security filters (platform) need it, and the dependency direction in this
 * repo is one-way: platform composes shared, never the reverse. shared/ carries
 * its own package.json and is consumed directly by the services, so a require
 * pointing up into platform/ would make it unpackageable.
 *
 * In-process on purpose, and NOT a replacement for Redis. See cache.js for what
 * a multi-instance deployment gets when Redis is absent: each instance keeps its
 * own copy, so an eviction on one is invisible to the others until the TTL
 * lapses. For the rate limiters the same split means an effective limit of
 * roughly N x the configured one across N instances — exact for a single
 * deploy, which is this repo's default shape.
 */
class TtlStore {
  constructor({ sweepIntervalMs = 60_000, maxEntries = 50_000 } = {}) {
    this.entries = new Map();
    this.maxEntries = maxEntries;
    // unref so a idle sweeper never holds the process open.
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlSeconds) {
    /**
     * A hard cap, because these keys are attacker-influenced: one IP per key
     * means a spray of forged addresses could grow this without bound. Oldest
     * insertions go first, which is the cheapest eviction that cannot itself be
     * gamed into evicting a specific victim's counter.
     */
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return value;
  }

  delete(key) { return this.entries.delete(key); }

  /**
   * Increments a counter within a fixed window, returning the new count and
   * when the window resets.
   *
   * A fixed window rather than a sliding one: it is one map entry per key and
   * cannot be starved by a long tail of timestamps. The known trade-off is that
   * a burst straddling a boundary can reach 2x the limit briefly.
   */
  increment(key, ttlSeconds) {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.set(key, 1, ttlSeconds);
      return { count: 1, resetAt: now + ttlSeconds * 1000 };
    }
    entry.value += 1;
    return { count: entry.value, resetAt: entry.expiresAt };
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  get size() { return this.entries.size; }
}

module.exports = { TtlStore };
