// Drošības palīgfunkcijas: HTTP galvenes, tā paša izcelsmes pārbaude, ātruma ierobežojumi (Postgres),
// robotu pārbaude (parakstīts talons + darba pierādījums) un datu uzkopšana.
const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const IS_PROD = process.env.NODE_ENV === 'production';

const hmac = (data) => crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');

// ---- HTTP drošības galvenes + Content-Security-Policy (ar nonce inline skriptiem) ----
function securityHeaders(req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://*.public.blob.vercel-storage.com",
    "media-src 'self' https://*.public.blob.vercel-storage.com",
    "font-src 'self'",
    "connect-src 'self'",
    'frame-src https://www.openstreetmap.org',
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ];
  if (IS_PROD) csp.push('upgrade-insecure-requests');
  res.setHeader('Content-Security-Policy', csp.join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// ---- Pieprasījumam jānāk no mūsu pašu lapas (aizsardzība pret CSRF un ārējām formām) ----
function sameOriginOnly(req, res, next) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim().toLowerCase();
  const source = req.headers.origin || req.headers.referer;
  let ok = false;
  try {
    ok = !!source && new URL(source).host.toLowerCase() === host;
  } catch { ok = false; }
  if (ok) return next();
  const wantsJson = (req.headers.accept || '').includes('json') || (req.headers['content-type'] || '').includes('json')
    || (req.headers['content-type'] || '').includes('multipart');
  if (wantsJson) return res.status(403).json({ ok: false, error: 'Pieprasījums noraidīts (nepareiza izcelsme).' });
  return res.status(403).send('Pieprasījums noraidīts.');
}

// ---- Tabulas ātruma ierobežojumiem un vienreizlietojamiem talonu identifikatoriem ----
let schemaPromise = null;
function ensureSchema(sql, deleteBlob) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS rate_events (
        id bigserial PRIMARY KEY,
        kind text NOT NULL,
        ip text NOT NULL,
        at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS rate_events_lookup ON rate_events (kind, ip, at)`;
      await sql`CREATE TABLE IF NOT EXISTS used_tokens (
        nonce text PRIMARY KEY,
        at timestamptz NOT NULL DEFAULT now()
      )`;
      await housekeeping(sql, deleteBlob);
    })().catch((err) => { schemaPromise = null; throw err; });
  }
  return schemaPromise;
}

// Datu glabāšanas termiņi (jāsakrīt ar Privātuma politiku): pieprasījumi — 24 mēneši, tehniskie žurnāli — dažas dienas.
const QUOTE_RETENTION_MONTHS = 24;
async function housekeeping(sql, deleteBlob) {
  try {
    await sql`DELETE FROM rate_events WHERE at < now() - interval '2 days'`;
    await sql`DELETE FROM used_tokens WHERE at < now() - interval '1 day'`;
    await sql`DELETE FROM login_attempts WHERE attempted_at < now() - interval '7 days'`;
    const old = await sql`
      DELETE FROM quote_requests
      WHERE submitted_at < now() - make_interval(months => ${QUOTE_RETENTION_MONTHS})
      RETURNING attachment_url`;
    if (deleteBlob) {
      for (const row of old) if (row.attachment_url) deleteBlob(row.attachment_url).catch(() => {});
    }
  } catch (err) {
    console.error('Datu uzkopšana neizdevās:', err.message);
  }
}

async function rateCount(sql, kind, ip, windowMinutes) {
  const rows = await sql`
    SELECT count(*)::int AS n FROM rate_events
    WHERE kind = ${kind} AND ip = ${ip} AND at > now() - make_interval(mins => ${windowMinutes})`;
  return rows[0] ? rows[0].n : 0;
}
async function rateHit(sql, kind, ip) {
  await sql`INSERT INTO rate_events (kind, ip) VALUES (${kind}, ${ip})`;
}
// Atgriež true, ja limits pārsniegts; pretējā gadījumā reģistrē notikumu.
async function rateLimited(sql, kind, ip, max, windowMinutes) {
  if (await rateCount(sql, kind, ip, windowMinutes) >= max) return true;
  await rateHit(sql, kind, ip);
  return false;
}

// ---- Robotu pārbaude: parakstīts talons + darba pierādījums (SHA-256), bez trešo pušu pakalpojumiem ----
const CHALLENGE_BITS = 15;
const CHALLENGE_MIN_AGE_MS = 4 * 1000;
const CHALLENGE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function issueChallenge() {
  const body = `${Date.now()}.${crypto.randomBytes(12).toString('base64url')}`;
  return { token: `${body}.${hmac('chal:' + body)}`, bits: CHALLENGE_BITS };
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

// Atgriež null, ja viss kārtībā, vai kļūdas kodu.
async function verifyChallenge(sql, token, solution) {
  if (typeof token !== 'string' || typeof solution !== 'string' || solution.length > 24 || token.length > 120) return 'missing';
  const parts = token.split('.');
  if (parts.length !== 3) return 'format';
  const [ts, nonce, sig] = parts;
  const expected = hmac(`chal:${ts}.${nonce}`);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'signature';
  const age = Date.now() - Number(ts);
  if (!(age >= CHALLENGE_MIN_AGE_MS)) return 'too-fast';
  if (age > CHALLENGE_MAX_AGE_MS) return 'expired';
  const digest = crypto.createHash('sha256').update(`${token}:${solution}`).digest();
  if (leadingZeroBits(digest) < CHALLENGE_BITS) return 'work';
  try {
    await sql`INSERT INTO used_tokens (nonce) VALUES (${nonce})`;
  } catch {
    return 'replay';
  }
  return null;
}

module.exports = {
  securityHeaders, sameOriginOnly, ensureSchema, rateCount, rateHit, rateLimited,
  issueChallenge, verifyChallenge, QUOTE_RETENTION_MONTHS, IS_PROD,
};
