require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { neon } = require('@neondatabase/serverless');
const { put: putBlob, del: deleteBlob } = require('@vercel/blob');
const security = require('./lib/security');
const uploads = require('./lib/uploads');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 10, fieldSize: 10 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(security.securityHeaders);

const sql = neon(process.env.DATABASE_URL);

// ---- E-pasta sūtīšana (cenu pieprasījumi) ----
const MAIL_TO = process.env.MAIL_TO || 'sales@elspot.lv';
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getMailTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendQuoteEmail(quote) {
  const transporter = getMailTransporter();
  if (!transporter) {
    console.warn('SMTP nav konfigurēts (.env trūkst SMTP_HOST/SMTP_USER/SMTP_PASS) — e-pasts par cenu pieprasījumu netika nosūtīts.');
    return;
  }
  const lines = [
    `Vārds/uzņēmums: ${quote.name}`,
    `Kontakti: ${quote.contact}`,
    `Ziņa: ${quote.message || '(nav norādīta)'}`,
    '',
    '---',
    `IP: ${quote.ip || 'nezināma'}  |  Piekrišana privātuma politikai: jā`,
  ];
  if (quote.attachmentUrl) {
    lines.push(`Pielikums: ${quote.attachmentUrl}${quote.attachmentOriginalName ? ' (' + quote.attachmentOriginalName + ')' : ''}`);
  }
  await transporter.sendMail({
    from: `"ELSPOT mājaslapa" <${MAIL_FROM}>`,
    to: MAIL_TO,
    replyTo: EMAIL_RE.test(String(quote.contact).trim()) ? String(quote.contact).trim() : undefined,
    subject: `Jauns cenu pieprasījums no ${String(quote.name).replace(/[\r\n]+/g, ' ')}`.slice(0, 200),
    text: lines.join('\n'),
  });
}

const PAGES = {
  home: { template: 'home', label: 'Galvenā' },
  produkti: { template: 'produkti', label: 'Produkti' },
  pakalpojumi: { template: 'pakalpojumi', label: 'Pakalpojumi' },
  'par-mums': { template: 'par-mums', label: 'Par mums' },
  kontakti: { template: 'kontakti', label: 'Kontakti' },
};

// ---- Satura palīgfunkcijas (Postgres) ----
async function readContent() {
  const rows = await sql`SELECT content FROM site_content WHERE id = 1`;
  if (!rows[0]) throw new Error('Saturs nav atrasts datubāzē. Palaid: npm run migrate');
  return rows[0].content;
}
async function writeContent(content) {
  await sql`UPDATE site_content SET content = ${JSON.stringify(content)}::jsonb WHERE id = 1`;
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
}

// ---- Ceļa palīgfunkcijas (atbalsta masīvu indeksus, piem. "whyItems.0.title") ----
function setPath(obj, pathStr, value) {
  const parts = pathStr.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (cur[key] === undefined || cur[key] === null) return false;
    cur = cur[key];
  }
  const lastKey = /^\d+$/.test(parts[parts.length - 1]) ? Number(parts[parts.length - 1]) : parts[parts.length - 1];
  if (!(lastKey in cur)) return false;
  cur[lastKey] = value;
  return true;
}

// ---- Skatu dzinējs ----
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.locals.editAttrs = (editMode, field) =>
  editMode ? ` contenteditable="true" data-field="${field}"` : '';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---- Bezstāvokļa autentifikācija ar parakstītu sīkdatni (nav sesiju krātuves — nepieciešams serverless videi) ----
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const COOKIE_NAME = 'elspot_admin';

function signPayload(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}
function createSessionCookieValue() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MAX_AGE_MS })).toString('base64url');
  return `${payload}.${signPayload(payload)}`;
}
function verifySessionCookieValue(value) {
  if (!value) return false;
  const dot = value.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expectedSig = signPayload(payload);
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  return verifySessionCookieValue(parseCookies(req)[COOKIE_NAME]);
}
function setSessionCookie(res) {
  const parts = [
    `${COOKIE_NAME}=${createSessionCookieValue()}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`,
    'SameSite=Strict',
  ];
  if (IS_PROD) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${IS_PROD ? '; Secure' : ''}`);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.redirect('/admin/login');
}
function requireAuthApi(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ ok: false, error: 'Sesija beigusies. Lūdzu, piesakies no jauna.' });
}

// ---- Lapas atveidošana (koplietota publiskajai vietnei un admin rediģēšanas režīmam) ----
async function renderPage(slug, req, res, editMode) {
  const content = await readContent();
  const page = PAGES[slug];
  const locals = {
    site: content.site,
    activeNav: slug,
    editMode,
    slug,
    pageLabel: page.label,
  };
  if (slug === 'home') {
    locals.home = content.home;
  } else {
    locals.page = content[slug];
  }
  res.render(page.template, locals);
}

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ---- Izstrādes režīms ("Under construction") ----
// Kad content.site.maintenance ir true, apmeklētāji redz izstrādes lapu (503),
// bet pieteikušies administratori turpina redzēt īsto vietni. /admin un statiskie faili vienmēr strādā.
function renderMaintenance(res, content, status) {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  if (status === 503) res.set('Retry-After', '86400');
  res.status(status).render('maintenance', { site: content.site, contact: content.kontakti || {} });
}

async function maintenanceGate(req, res, next) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/admin') || req.path === '/under-construction') return next();
    const content = await readContent();
    if (!(content.site && content.site.maintenance)) return next();
    if (isAuthed(req)) return next();
    renderMaintenance(res, content, 503);
  } catch (err) {
    next(err);
  }
}
app.use(maintenanceGate);

// Izstrādes lapas priekšskatījums (vienmēr pieejams, neatkarīgi no slēdža)
app.get('/under-construction', asyncRoute(async (req, res) => {
  renderMaintenance(res, await readContent(), 200);
}));

// ---- Publiskie maršruti ----
Object.keys(PAGES).forEach((slug) => {
  const route = slug === 'home' ? '/' : `/${slug}`;
  app.get(route, asyncRoute((req, res) => renderPage(slug, req, res, false)));
});

// ---- Juridiskās lapas (privātuma un sīkdatņu politika) ----
[['privatuma-politika', 'Privātuma politika'], ['sikdatnu-politika', 'Sīkdatņu politika']].forEach(([route, label]) => {
  app.get('/' + route, asyncRoute(async (req, res) => {
    const content = await readContent();
    res.render(route, {
      site: content.site,
      kontakti: content.kontakti,
      editMode: false,
      activeNav: 'legal',
      slug: route,
      pageLabel: label,
    });
  }));
});

// ---- Produkti sections (virsnodaļas) ----
async function renderProductSection(req, res, editMode) {
  const content = await readContent();
  const sections = content.produkti.sections;
  const sectionIndex = sections.findIndex((s) => s.slug === req.params.section);
  if (sectionIndex === -1) return res.status(404).send('Sadaļa nav atrasta.');
  const section = sections[sectionIndex];
  res.render('produkti-section', {
    site: content.site,
    section,
    sectionIndex,
    editMode,
    activeNav: 'produkti',
    slug: 'produkti/' + section.slug,
    pageLabel: 'Produkti — ' + section.title,
  });
}
app.get('/produkti/:section', asyncRoute((req, res) => renderProductSection(req, res, false)));
app.get('/admin/edit/produkti/:section', requireAuth, asyncRoute((req, res) => renderProductSection(req, res, true)));

// ---- Produktu kategoriju detalizētās lapas ----
async function renderProductCategory(req, res, editMode) {
  const content = await readContent();
  const sections = content.produkti.sections;
  const sectionIndex = sections.findIndex((s) => s.slug === req.params.section);
  if (sectionIndex === -1) return res.status(404).send('Sadaļa nav atrasta.');
  const section = sections[sectionIndex];
  const categories = section.categories;
  const categoryIndex = categories.findIndex((c) => c.slug === req.params.category);
  if (categoryIndex === -1) return res.status(404).send('Kategorija nav atrasta.');
  res.render('produkti-kategorija', {
    site: content.site,
    section,
    sectionIndex,
    category: categories[categoryIndex],
    categoryIndex,
    editMode,
    activeNav: 'produkti',
    slug: 'produkti/' + section.slug + '/' + categories[categoryIndex].slug,
    pageLabel: 'Produkti — ' + section.title + ' — ' + categories[categoryIndex].title,
  });
}
app.get('/produkti/:section/:category', asyncRoute((req, res) => renderProductCategory(req, res, false)));
app.get('/admin/edit/produkti/:section/:category', requireAuth, asyncRoute((req, res) => renderProductCategory(req, res, true)));

// ---- Robotu pārbaude veidlapām (talons + darba pierādījums) ----
app.get('/api/challenge', asyncRoute(async (req, res) => {
  await security.ensureSchema(sql, deleteBlob);
  const ip = getClientIp(req) || 'unknown';
  if (await security.rateLimited(sql, 'challenge', ip, 40, 10)) {
    return res.status(429).json({ ok: false, error: 'Pārāk daudz pieprasījumu.' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ...security.issueChallenge() });
}));

// ---- Cenu pieprasījumi un kontaktforma (publiski, ar vairāku līmeņu aizsardzību pret robotiem) ----
const quoteUpload = upload.single('attachment');

function handleQuoteUpload(req, res, next) {
  quoteUpload(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ ok: false, error: 'Fails ir par lielu. Maksimālais izmērs ir 4MB.' });
      }
      return res.status(400).json({ ok: false, error: 'Neizdevās augšupielādēt failu.' });
    }
    next();
  });
}

const QUOTE_LIMITS = [
  // [veids, atslēga, max, logs minūtēs]
  ['quote', 'ip', 8, 15],
  ['quote-day', 'ip', 20, 1440],
  ['quote-all', 'global', 100, 60],
];
const PHONE_DIGITS_RE = /\d/g;
const EMAIL_IN_TEXT_RE = /[^\s@/,;]+@[^\s@/,;]+\.[^\s@/,;]{2,}/;
const stripControl = (v) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

app.post('/quote', security.sameOriginOnly, handleQuoteUpload, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const file = req.file;
  const ip = getClientIp(req) || 'unknown';

  // 1) Slēptais "medus podiņa" lauks — cilvēki to neredz, boti bieži aizpilda visus laukus. Botam rādām "veiksmi".
  if (body.website) return res.json({ ok: true });

  await security.ensureSchema(sql, deleteBlob);

  // 2) Ātruma ierobežojumi (katrs mēģinājums tiek uzskaitīts, arī nederīgie)
  for (const [kind, scope, max, minutes] of QUOTE_LIMITS) {
    if (await security.rateLimited(sql, kind, scope === 'ip' ? ip : 'global', max, minutes)) {
      return res.status(429).json({ ok: false, error: 'Pārāk daudz pieprasījumu. Lūdzu, mēģini vēlreiz vēlāk.' });
    }
  }

  // 3) Cilvēka pārbaude: parakstīts talons, vecums, darba pierādījums, vienreizlietojums
  const challengeError = await security.verifyChallenge(sql, body.ch_token, body.ch_solution);
  if (challengeError) {
    const msg = challengeError === 'too-fast' || challengeError === 'work' || challengeError === 'missing'
      ? 'Drošības pārbaude vēl nav pabeigta. Uzgaidi sekundi un mēģini vēlreiz.'
      : 'Drošības pārbaude beigusies. Lūdzu, atsvaidzini lapu un mēģini vēlreiz.';
    return res.status(400).json({ ok: false, error: msg });
  }

  // 4) Lauku pārbaude un attīrīšana
  const name = stripControl(body.name).replace(/\s+/g, ' ');
  const contact = stripControl(body.contact).replace(/\s+/g, ' ');
  const message = stripControl(body.message);
  const consent = body.consent === true || body.consent === 'true' || body.consent === 'on' || body.consent === '1';

  if (!name || !contact) {
    return res.status(400).json({ ok: false, error: 'Lūdzu, norādi vārdu un kontaktinformāciju.' });
  }
  if (!consent) {
    return res.status(400).json({ ok: false, error: 'Lūdzu, apstiprini, ka esi iepazinies ar privātuma politiku.' });
  }
  if (name.length < 2 || name.length > 200 || contact.length > 200 || message.length > 2000) {
    return res.status(400).json({ ok: false, error: 'Lūdzu, pārbaudi ievadīto datu garumu.' });
  }
  const digits = (contact.match(PHONE_DIGITS_RE) || []).length;
  if (!EMAIL_IN_TEXT_RE.test(contact) && digits < 7) {
    return res.status(400).json({ ok: false, error: 'Lūdzu, norādi derīgu e-pastu vai tālruņa numuru.' });
  }
  const linkCount = (name + ' ' + message).match(/(https?:\/\/|www\.)/gi);
  if (linkCount && linkCount.length > 2) {
    return res.status(400).json({ ok: false, error: 'Ziņā drīkst būt ne vairāk kā 2 saites.' });
  }

  // 5) Pielikums: pārbaude pēc satura, nejaušs nosaukums, attēlu pārkodēšana
  let attachment = null;
  if (file) {
    attachment = await uploads.processAttachment(file);
    if (attachment.error) return res.status(400).json({ ok: false, error: attachment.error });
  }

  let attachmentUrl = null;
  if (attachment) {
    const blob = await putBlob(attachment.pathname, attachment.buffer, {
      access: 'public',
      contentType: attachment.contentType,
      addRandomSuffix: true,
    });
    attachmentUrl = blob.url;
  }

  const quote = {
    name,
    contact,
    message,
    attachmentUrl,
    attachmentOriginalName: file ? uploads.safeDisplayName(file.originalname) : null,
    ip,
  };

  await sql`
    INSERT INTO quote_requests (name, contact, message, attachment_url, attachment_original_name, ip)
    VALUES (${quote.name}, ${quote.contact}, ${quote.message}, ${quote.attachmentUrl}, ${quote.attachmentOriginalName}, ${ip})
  `;

  try {
    await sendQuoteEmail(quote);
  } catch (err) {
    console.error('Neizdevās nosūtīt e-pastu par cenu pieprasījumu:', err);
  }

  res.json({ ok: true });
}));

// ---- Admin maršruti ----
// Visiem POST pieprasījumiem uz /admin jānāk no mūsu pašu lapas; admin lapas netiek kešotas.
app.use('/admin', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  if (req.method === 'POST') return security.sameOriginOnly(req, res, next);
  next();
});

app.get('/admin/login', (req, res) => {
  res.render('admin/login', { error: null });
});

const LOGIN_MAX_ATTEMPTS = 3;
const LOGIN_LOCKOUT_MINUTES = 60;
const LOCKOUT_MESSAGE = 'Pārāk daudz nepareizu mēģinājumu. Piekļuve uz brīdi bloķēta — mēģini vēlreiz pēc stundas.';

async function isLockedOut(ip) {
  if (!ip) return false;
  const rows = await sql`
    SELECT count(*)::int AS n FROM login_attempts
    WHERE ip = ${ip} AND attempted_at > now() - make_interval(mins => ${LOGIN_LOCKOUT_MINUTES})
  `;
  return !!(rows[0] && rows[0].n >= LOGIN_MAX_ATTEMPTS);
}
async function recordFailure(ip) {
  if (ip) await sql`INSERT INTO login_attempts (ip) VALUES (${ip})`;
}

// ---- Papildu aizsardzība: vienreizējs PIN kods uz administratora e-pastu (ieslēdzas, ja iestatīts ADMIN_2FA_EMAIL) ----
const PENDING_COOKIE = 'elspot_2fa';
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const getTwoFactorEmail = () => (process.env.ADMIN_2FA_EMAIL || '').trim();

function maskEmail(email) {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(user.length - 1, 6)))}@${domain}`;
}
function pinSignature(payload, pin) {
  return signPayload(`2fa:${payload}:${pin}`);
}
function createPendingValue(pin) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + PENDING_MAX_AGE_MS, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${pinSignature(payload, pin)}`;
}
function readPending(req) {
  const value = parseCookies(req)[PENDING_COOKIE];
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = value.slice(0, dot);
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
  } catch { return null; }
  return { payload, sig: value.slice(dot + 1) };
}
function pendingCookieHeader(value, maxAgeSeconds) {
  return `${PENDING_COOKIE}=${value}; HttpOnly; Path=/admin; Max-Age=${maxAgeSeconds}; SameSite=Strict${IS_PROD ? '; Secure' : ''}`;
}

app.post('/admin/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIp(req);

  if (await isLockedOut(ip)) {
    return res.render('admin/login', { error: LOCKOUT_MESSAGE });
  }

  const adminUser = process.env.ADMIN_USERNAME;
  const adminHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminUser || !adminHash) {
    return res.render('admin/login', { error: 'Admin konts nav konfigurēts (trūkst ADMIN_USERNAME/ADMIN_PASSWORD_HASH).' });
  }
  // Paroli pārbaudām vienmēr (arī ja lietotājvārds nepareizs), lai atbildes laiks neatklātu lietotājvārdu.
  const u = Buffer.from(String(username || '')), a = Buffer.from(adminUser);
  const userOk = u.length === a.length && crypto.timingSafeEqual(u, a);
  const passOk = bcrypt.compareSync(String(password || '').slice(0, 200), adminHash);

  if (!(userOk && passOk)) {
    await recordFailure(ip);
    return res.render('admin/login', { error: 'Nepareizs lietotājvārds vai parole.' });
  }

  const twoFactorEmail = getTwoFactorEmail();
  if (!twoFactorEmail) {
    setSessionCookie(res);
    return res.redirect('/admin/edit/home');
  }

  // Otrais solis: nosūtām 6 ciparu PIN uz administratora e-pastu.
  await security.ensureSchema(sql, deleteBlob);
  if (await security.rateLimited(sql, '2fa-mail', ip || 'unknown', 5, 60)) {
    return res.render('admin/login', { error: 'Pārāk daudz PIN kodu pieprasījumu. Mēģini vēlreiz vēlāk.' });
  }
  const transporter = getMailTransporter();
  if (!transporter) {
    return res.render('admin/login', { error: 'E-pasta sūtīšana nav konfigurēta, tāpēc PIN kodu nevar nosūtīt.' });
  }
  const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  try {
    await transporter.sendMail({
      from: `"ELSPOT mājaslapa" <${MAIL_FROM}>`,
      to: twoFactorEmail,
      subject: 'ELSPOT admin pieslēgšanās kods',
      text: [
        `Jūsu vienreizējais pieslēgšanās kods: ${pin}`,
        '',
        'Kods ir derīgs 10 minūtes.',
        `Pieslēgšanās mēģinājums no IP: ${ip || 'nezināma'}`,
        '',
        'Ja to nedarījāt jūs, nevienam nenosūtiet šo kodu un nomainiet admin paroli.',
      ].join('\n'),
    });
  } catch (err) {
    console.error('Neizdevās nosūtīt admin PIN:', err);
    return res.render('admin/login', { error: 'Neizdevās nosūtīt PIN kodu uz e-pastu. Mēģini vēlreiz.' });
  }
  res.append('Set-Cookie', pendingCookieHeader(createPendingValue(pin), Math.floor(PENDING_MAX_AGE_MS / 1000)));
  res.redirect('/admin/verify');
}));

app.get('/admin/verify', (req, res) => {
  const email = getTwoFactorEmail();
  if (!email || !readPending(req)) return res.redirect('/admin/login');
  res.render('admin/verify', { error: null, maskedEmail: maskEmail(email) });
});

app.post('/admin/verify', asyncRoute(async (req, res) => {
  const email = getTwoFactorEmail();
  const pending = readPending(req);
  const ip = getClientIp(req);
  if (!email || !pending) return res.redirect('/admin/login');
  if (await isLockedOut(ip)) {
    return res.render('admin/verify', { error: LOCKOUT_MESSAGE, maskedEmail: maskEmail(email) });
  }
  const pin = String((req.body && req.body.pin) || '').replace(/\s+/g, '');
  const expected = Buffer.from(pinSignature(pending.payload, pin));
  const given = Buffer.from(pending.sig);
  const ok = /^\d{6}$/.test(pin) && expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (!ok) {
    await recordFailure(ip);
    return res.render('admin/verify', { error: 'Nepareizs PIN kods.', maskedEmail: maskEmail(email) });
  }
  res.append('Set-Cookie', pendingCookieHeader('', 0));
  setSessionCookie(res);
  res.redirect('/admin/edit/home');
}));

app.post('/admin/logout', requireAuth, (req, res) => {
  clearSessionCookie(res);
  res.redirect('/admin/login');
});

app.get('/admin', requireAuth, (req, res) => res.redirect('/admin/edit/home'));
app.get('/admin/dashboard', requireAuth, (req, res) => res.redirect('/admin/edit/home'));

app.get('/admin/edit/:slug', requireAuth, asyncRoute(async (req, res) => {
  const { slug } = req.params;
  if (!PAGES[slug]) return res.status(404).send('Lapa nav atrasta.');
  await renderPage(slug, req, res, true);
}));

app.post('/admin/api/maintenance', requireAuthApi, asyncRoute(async (req, res) => {
  const enabled = req.body.enabled === true || req.body.enabled === 'true';
  const content = await readContent();
  content.site.maintenance = enabled;
  await writeContent(content);
  res.json({ ok: true, enabled });
}));

app.post('/admin/api/content', requireAuthApi, asyncRoute(async (req, res) => {
  const { page, fields } = req.body;
  // Produkti apakšlapām (sadaļām/kategorijām) "page" ir salikts ceļš, piem.
  // "produkti/apgaismojums" vai "produkti/apgaismojums/iekstelpu-apgaismojums" —
  // saturs tomēr vienmēr glabājas zem vienas "produkti" saknes.
  const basePage = typeof page === 'string' ? page.split('/')[0] : page;
  if (!basePage || !PAGES[basePage] || typeof fields !== 'object' || fields === null) {
    return res.status(400).json({ ok: false, error: 'Nepareizi dati.' });
  }
  // Kartes koordinātām jābūt skaitļiem, citādi karte nezina, kur likt pinu.
  for (const [fieldPath, rawValue] of Object.entries(fields)) {
    if (/(^|\.)map(Lat|Lng)$/.test(fieldPath)) {
      const n = Number(String(rawValue).trim().replace(',', '.'));
      const limit = /Lat$/.test(fieldPath) ? 90 : 180;
      if (!Number.isFinite(n) || Math.abs(n) > limit) {
        return res.status(400).json({ ok: false, error: 'Kartes koordinātām jābūt skaitļiem (piem., platums 56.9296, garums 24.2071). Waze/Google saites tiek veidotas automātiski.' });
      }
      fields[fieldPath] = String(n);
    }
  }
  const content = await readContent();
  const target = basePage === 'home' ? content.home : content[basePage];
  const applied = [];
  for (const [fieldPath, rawValue] of Object.entries(fields)) {
    const value = String(rawValue).slice(0, 5000);
    if (setPath(target, fieldPath, value)) applied.push(fieldPath);
  }
  await writeContent(content);
  res.json({ ok: true, applied });
}));

// ---- Admin attēlu augšupielāde (servera puse: pārbaude pēc satura, pārkodēšana, nejaušs nosaukums) ----
// Lauks, kuram piešķir attēla adresi, drīkst būt tikai attēla lauks (nevis jebkurš teksta lauks).
const IMAGE_FIELD_RE = /(^|\.)(logo|logoInverse|image|heroImage)$/;
const BLOB_URL_RE = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i;

function handleImageUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ ok: false, error: 'Attēls ir par lielu. Maksimālais izmērs ir 4MB.' });
      }
      return res.status(400).json({ ok: false, error: 'Neizdevās augšupielādēt attēlu.' });
    }
    next();
  });
}

app.post('/admin/api/image', requireAuthApi, handleImageUpload, asyncRoute(async (req, res) => {
  const { field } = req.body;
  const file = req.file;
  if (!field || !file) {
    return res.status(400).json({ ok: false, error: 'Trūkst attēla vai lauka nosaukuma.' });
  }
  if (!IMAGE_FIELD_RE.test(String(field))) {
    return res.status(400).json({ ok: false, error: 'Šim laukam nevar piešķirt attēlu.' });
  }
  await security.ensureSchema(sql, deleteBlob);
  if (await security.rateLimited(sql, 'upload', getClientIp(req) || 'unknown', 40, 10)) {
    return res.status(429).json({ ok: false, error: 'Pārāk daudz augšupielāžu. Mēģini vēlreiz pēc dažām minūtēm.' });
  }
  const processed = await uploads.processAdminImage(file);
  if (processed.error) {
    return res.status(400).json({ ok: false, error: processed.error });
  }
  const content = await readContent();
  if (!setPath(content, field, '')) {
    return res.status(400).json({ ok: false, error: 'Nezināms lauks: ' + field });
  }
  const blob = await putBlob(processed.pathname, processed.buffer, {
    access: 'public',
    contentType: processed.contentType,
    addRandomSuffix: true,
  });
  setPath(content, field, blob.url);
  await writeContent(content);
  res.json({ ok: true, url: blob.url });
}));

app.post('/admin/api/video', requireAuthApi, asyncRoute(async (req, res) => {
  const { field, url } = req.body;
  if (!field || !url) {
    return res.status(400).json({ ok: false, error: 'Trūkst video vai lauka nosaukuma.' });
  }
  if (!/(^|\.)heroVideo$/.test(String(field)) || !BLOB_URL_RE.test(String(url))) {
    return res.status(400).json({ ok: false, error: 'Nederīgs video lauks vai adrese.' });
  }
  const content = await readContent();
  if (!setPath(content, field, url)) {
    return res.status(400).json({ ok: false, error: 'Nezināms lauks: ' + field });
  }
  await writeContent(content);
  res.json({ ok: true, url });
}));

app.post('/admin/api/video/remove', requireAuthApi, asyncRoute(async (req, res) => {
  const { field } = req.body;
  if (!field || !/(^|\.)heroVideo$/.test(String(field))) {
    return res.status(400).json({ ok: false, error: 'Nederīgs video lauks.' });
  }
  const content = await readContent();
  const currentUrl = field.split('.').reduce((o, k) => (o == null ? o : o[/^\d+$/.test(k) ? Number(k) : k]), content);
  if (!setPath(content, field, null)) {
    return res.status(400).json({ ok: false, error: 'Nezināms lauks: ' + field });
  }
  await writeContent(content);
  if (currentUrl) {
    deleteBlob(currentUrl).catch(() => { /* labākā piepūle — nav kritiski, ja neizdodas */ });
  }
  res.json({ ok: true });
}));

app.post('/admin/api/produkti/manufacturer/add', requireAuthApi, asyncRoute(async (req, res) => {
  const sectionIndex = Number(req.body.sectionIndex);
  const categoryIndex = Number(req.body.categoryIndex);
  const content = await readContent();
  const section = content.produkti.sections[sectionIndex];
  const category = section && section.categories[categoryIndex];
  if (!category) {
    return res.status(400).json({ ok: false, error: 'Kategorija nav atrasta.' });
  }
  if (!Array.isArray(category.manufacturers)) category.manufacturers = [];
  category.manufacturers.push({ name: 'Ražotājs ' + (category.manufacturers.length + 1), logo: null, url: '' });
  await writeContent(content);
  res.json({ ok: true });
}));

app.post('/admin/api/produkti/manufacturer/remove', requireAuthApi, asyncRoute(async (req, res) => {
  const sectionIndex = Number(req.body.sectionIndex);
  const categoryIndex = Number(req.body.categoryIndex);
  const manufacturerIndex = Number(req.body.manufacturerIndex);
  const content = await readContent();
  const section = content.produkti.sections[sectionIndex];
  const category = section && section.categories[categoryIndex];
  if (!category || !Array.isArray(category.manufacturers) || !category.manufacturers[manufacturerIndex]) {
    return res.status(400).json({ ok: false, error: 'Ražotājs nav atrasts.' });
  }
  category.manufacturers.splice(manufacturerIndex, 1);
  await writeContent(content);
  res.json({ ok: true });
}));

app.post('/admin/api/produkti/category/add', requireAuthApi, asyncRoute(async (req, res) => {
  const sectionIndex = Number(req.body.sectionIndex);
  const content = await readContent();
  const section = content.produkti.sections[sectionIndex];
  if (!section) {
    return res.status(400).json({ ok: false, error: 'Sadaļa nav atrasta.' });
  }
  if (!Array.isArray(section.categories)) section.categories = [];
  const n = section.categories.length + 1;
  section.categories.push({
    slug: 'kategorija-' + n,
    title: 'Kategorija ' + n,
    image: null,
    intro: '',
    manufacturers: [],
  });
  await writeContent(content);
  res.json({ ok: true });
}));

app.post('/admin/api/produkti/category/remove', requireAuthApi, asyncRoute(async (req, res) => {
  const sectionIndex = Number(req.body.sectionIndex);
  const categoryIndex = Number(req.body.categoryIndex);
  const content = await readContent();
  const section = content.produkti.sections[sectionIndex];
  if (!section || !Array.isArray(section.categories) || !section.categories[categoryIndex]) {
    return res.status(400).json({ ok: false, error: 'Kategorija nav atrasta.' });
  }
  section.categories.splice(categoryIndex, 1);
  await writeContent(content);
  res.json({ ok: true });
}));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: 'Servera kļūda. Mēģini vēlreiz.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ELSPOT mājaslapa darbojas: http://localhost:${PORT}`);
  });
}

module.exports = app;
