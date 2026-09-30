const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { TtlStore } = require('./ttlStore');
const { normalizeCode } = require('./shortCode');

/**
 * How often each share link is opened — counted without a write per view.
 *
 * A link pasted into a busy group chat is opened by dozens of people inside a
 * minute. A write per open would make the public page, which is otherwise
 * served from cache, the most expensive request in the product, and would keep
 * a serverless database awake for as long as anybody was looking.
 *
 * So views are tallied in memory and FLUSHED: one UPDATE per link that was
 * actually opened, at most once a minute, and nothing at all when nobody is
 * looking. The same visitor re-opening the page inside half an hour counts
 * once — a refresh is not a second prospect.
 *
 * ── What is traded ──────────────────────────────────────────────────────────
 *
 * Up to a minute of views can be lost if the process dies without a clean
 * shutdown, and with several instances each dedupes its own visitors. Both are
 * acceptable for a figure whose job is "is anybody opening my link", and the
 * alternative is a write on the hottest public read. The visitor key is a
 * salted hash of address and browser, kept only in memory for the dedupe
 * window — nothing about the visitor is stored.
 */

const FLUSH_MS = 60_000;
const DEDUPE_SECONDS = 30 * 60;

const pending = new Map(); // code -> { count, lastAt }
const seen = new TtlStore({ maxEntries: 50_000 });
const salt = crypto.randomBytes(16).toString('hex');
let flushTimer = null;
let boundSequelize = null;

const visitorKey = (req) => {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const address = forwarded || req.ip || req.socket?.remoteAddress || '';
  const agent = String(req.headers?.['user-agent'] || '');
  return crypto.createHash('sha256').update(`${salt}|${address}|${agent}`).digest('hex').slice(0, 32);
};

/**
 * Writes the tally. Each link is one statement that ADDS to the stored count,
 * so two instances flushing at once cannot overwrite each other.
 */
const flush = async () => {
  if (!boundSequelize || !pending.size) return;
  const batch = [...pending.entries()];
  pending.clear();
  for (const [code, { count, lastAt }] of batch) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await boundSequelize.query(
        `UPDATE referral_links
            SET view_count = COALESCE(view_count, 0) + :count, last_viewed_at = :lastAt
          WHERE code = :code`,
        { replacements: { code, count, lastAt }, type: QueryTypes.UPDATE },
      );
    } catch (error) {
      // Most likely the columns are not there yet (user-service owns the
      // table and adds them on its boot). The views are dropped rather than
      // retried forever — a count is not worth an unbounded buffer.
      console.error(`[share-views] flush failed for ${code}: ${error.message}`);
    }
  }
};

const schedule = () => {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {});
  }, FLUSH_MS);
  flushTimer.unref?.();
};

let shutdownHooked = false;
const hookShutdown = () => {
  if (shutdownHooked) return;
  shutdownHooked = true;
  process.once('beforeExit', () => { flush().catch(() => {}); });
  /*
   * A SIGTERM listener replaces Node's default "exit now", so this one
   * flushes (for at most two seconds) and then re-raises the signal — `once`
   * has already removed it, so the second delivery exits exactly as the
   * process would have without this file.
   */
  process.once('SIGTERM', () => {
    const exit = () => process.kill(process.pid, 'SIGTERM');
    Promise.race([flush(), new Promise((resolve) => { setTimeout(resolve, 2000).unref?.(); })])
      .catch(() => {})
      .finally(exit);
  });
};

/**
 * Counts one open of a short-code link. Synchronous and never throws — the
 * page it is called from must not wait on, or fail over, a view count.
 */
const recordShareView = (sequelize, code, req) => {
  try {
    if (!code) return;
    boundSequelize = sequelize;
    hookShutdown();
    const normalized = normalizeCode(code);
    const dedupe = `${normalized}:${visitorKey(req)}`;
    if (seen.get(dedupe)) return;
    seen.set(dedupe, true, DEDUPE_SECONDS);
    const entry = pending.get(normalized) || { count: 0, lastAt: null };
    entry.count += 1;
    entry.lastAt = new Date();
    pending.set(normalized, entry);
    schedule();
  } catch (error) {
    console.error('[share-views] record failed:', error.message);
  }
};

module.exports = { recordShareView, flushShareViews: flush };
