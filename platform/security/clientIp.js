/**
 * The caller's IP, as far as it can be trusted.
 *
 * X-Forwarded-For is client-supplied and trivially spoofed, so it is only read
 * when TRUST_PROXY says this process actually sits behind one. Reading it
 * unconditionally — which is what the sample does — lets anyone choose their own
 * rate-limit bucket and defeat an IP allow-list by adding a header.
 */
const trustProxy = () => String(process.env.TRUST_PROXY ?? '').toLowerCase() === 'true';

const clientIp = (req) => {
  if (trustProxy()) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded && String(forwarded).toLowerCase() !== 'unknown') {
      // Left-most entry is the original client; the rest are proxies.
      return String(forwarded).split(',')[0].trim();
    }
    const realIp = req.headers['x-real-ip'];
    if (realIp && String(realIp).toLowerCase() !== 'unknown') return String(realIp).trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
};

/** First three octets, for logs and fingerprints that should not carry a full IP. */
const maskIp = (ip) => {
  const parts = String(ip || '').split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.xxx` : 'unknown';
};

module.exports = { clientIp, maskIp, trustProxy };
