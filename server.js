require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { neon } = require('@neondatabase/serverless');
const { handleUpload } = require('@vercel/blob/client');
const { del: deleteBlob } = require('@vercel/blob');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

app.set('trust proxy', true);

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
  ];
  if (quote.attachmentUrl) {
    lines.push(`Pielikums: ${quote.attachmentUrl}${quote.attachmentOriginalName ? ' (' + quote.attachmentOriginalName + ')' : ''}`);
  }
  await transporter.sendMail({
    from: `"ELSPOT mājaslapa" <${MAIL_FROM}>`,
    to: MAIL_TO,
    replyTo: EMAIL_RE.test(quote.contact) ? quote.contact : undefined,
    subject: `Jauns cenu pieprasījums no ${quote.name}`,
    text: lines.join('\n'),
  });
}

const PAGES = {
  home: { template: 'home', label: 'Galvenā' },
  produkti: { template: 'produkti', label: 'Produkti' },
  pakalpojumi: { template: 'coming-soon', label: 'Pakalpojumi' },
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
    'SameSite=Lax',
  ];
  if (IS_PROD) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${IS_PROD ? '; Secure' : ''}`);
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

// ---- Publiskie maršruti ----
Object.keys(PAGES).forEach((slug) => {
  const route = slug === 'home' ? '/' : `/${slug}`;
  app.get(route, asyncRoute((req, res) => renderPage(slug, req, res, false)));
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

// ---- Cenu pieprasījumu pielikumu augšupielāde (publiska, tieši uz Vercel Blob) ----
const QUOTE_ATTACHMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'application/x-zip-compressed',
  'image/vnd.dwg',
  'image/vnd.dxf',
  'application/octet-stream', // dwg/dxf bieži tiek sūtīti bez precīza MIME tipa
];
const QUOTE_ATTACHMENT_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.doc', '.docx', '.xls', '.xlsx', '.dwg', '.dxf', '.zip'];

app.post('/quote/blob-upload', asyncRoute(async (req, res) => {
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        const ext = path.extname(pathname).toLowerCase();
        if (!QUOTE_ATTACHMENT_EXTENSIONS.includes(ext)) {
          throw new Error('Neatbalstīts faila formāts.');
        }
        return {
          allowedContentTypes: QUOTE_ATTACHMENT_TYPES,
          maximumSizeInBytes: 20 * 1024 * 1024,
          addRandomSuffix: true,
        };
      },
    });
    res.json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Neizdevās sagatavot augšupielādi.' });
  }
}));

const QUOTE_RATE_LIMIT_MAX = 5;
const QUOTE_RATE_LIMIT_WINDOW_MINUTES = 15;

app.post('/quote', asyncRoute(async (req, res) => {
  const { name, contact, message, attachmentUrl, attachmentOriginalName, website } = req.body;

  // Slēptais "medus podiņa" lauks — cilvēki to neredz un neaizpilda, boti bieži aizpilda visus laukus.
  if (website) {
    return res.json({ ok: true });
  }

  if (!name || !contact) {
    return res.status(400).json({ ok: false, error: 'Lūdzu, norādi vārdu un kontaktinformāciju.' });
  }

  const ip = getClientIp(req);
  if (ip) {
    const recent = await sql`
      SELECT count(*)::int AS n FROM quote_requests
      WHERE ip = ${ip} AND submitted_at > now() - make_interval(mins => ${QUOTE_RATE_LIMIT_WINDOW_MINUTES})
    `;
    if (recent[0] && recent[0].n >= QUOTE_RATE_LIMIT_MAX) {
      return res.status(429).json({ ok: false, error: 'Pārāk daudz pieprasījumu. Lūdzu, mēģini vēlreiz vēlāk.' });
    }
  }

  const quote = {
    name: String(name).slice(0, 200),
    contact: String(contact).slice(0, 200),
    message: String(message || '').slice(0, 2000),
    attachmentUrl: attachmentUrl ? String(attachmentUrl).slice(0, 1000) : null,
    attachmentOriginalName: attachmentOriginalName ? String(attachmentOriginalName).slice(0, 300) : null,
  };

  await sql`
    INSERT INTO quote_requests (name, contact, message, attachment_url, attachment_original_name, ip)
    VALUES (${quote.name}, ${quote.contact}, ${quote.message}, ${quote.attachmentUrl}, ${quote.attachmentOriginalName}, ${ip || null})
  `;

  try {
    await sendQuoteEmail(quote);
  } catch (err) {
    console.error('Neizdevās nosūtīt e-pastu par cenu pieprasījumu:', err);
  }

  res.json({ ok: true });
}));

// ---- Admin maršruti ----
app.get('/admin/login', (req, res) => {
  res.render('admin/login', { error: null });
});

const LOGIN_MAX_ATTEMPTS = 3;
const LOGIN_LOCKOUT_MINUTES = 60;

app.post('/admin/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIp(req);

  if (ip) {
    const recentFails = await sql`
      SELECT count(*)::int AS n FROM login_attempts
      WHERE ip = ${ip} AND attempted_at > now() - make_interval(mins => ${LOGIN_LOCKOUT_MINUTES})
    `;
    if (recentFails[0] && recentFails[0].n >= LOGIN_MAX_ATTEMPTS) {
      return res.render('admin/login', { error: 'Pārāk daudz nepareizu mēģinājumu. Konts uz brīdi bloķēts — mēģini vēlreiz pēc stundas.' });
    }
  }

  const adminUser = process.env.ADMIN_USERNAME;
  const adminHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminUser || !adminHash) {
    return res.render('admin/login', { error: 'Admin konts nav konfigurēts (trūkst ADMIN_USERNAME/ADMIN_PASSWORD_HASH).' });
  }
  if (username === adminUser && bcrypt.compareSync(password || '', adminHash)) {
    setSessionCookie(res);
    return res.redirect('/admin/edit/home');
  }

  if (ip) {
    await sql`INSERT INTO login_attempts (ip) VALUES (${ip})`;
  }
  res.render('admin/login', { error: 'Nepareizs lietotājvārds vai parole.' });
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

app.post('/admin/api/content', requireAuthApi, asyncRoute(async (req, res) => {
  const { page, fields } = req.body;
  if (!page || !PAGES[page] || typeof fields !== 'object' || fields === null) {
    return res.status(400).json({ ok: false, error: 'Nepareizi dati.' });
  }
  const content = await readContent();
  const target = page === 'home' ? content.home : content[page];
  const applied = [];
  for (const [fieldPath, rawValue] of Object.entries(fields)) {
    const value = String(rawValue).slice(0, 5000);
    if (setPath(target, fieldPath, value)) applied.push(fieldPath);
  }
  await writeContent(content);
  res.json({ ok: true, applied });
}));

// ---- Admin attēlu/video augšupielāde (tieši uz Vercel Blob no pārlūka) ----
app.post('/admin/api/blob-upload', requireAuthApi, asyncRoute(async (req, res) => {
  const jsonResponse = await handleUpload({
    body: req.body,
    request: req,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      let kind = 'image';
      try { kind = JSON.parse(clientPayload || '{}').kind || 'image'; } catch { /* nekas jādara */ }
      const isVideo = kind === 'video';
      return {
        allowedContentTypes: isVideo
          ? ['video/mp4', 'video/webm', 'video/quicktime']
          : ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'],
        maximumSizeInBytes: isVideo ? 60 * 1024 * 1024 : 8 * 1024 * 1024,
        addRandomSuffix: true,
      };
    },
  });
  res.json(jsonResponse);
}));

app.post('/admin/api/image', requireAuthApi, asyncRoute(async (req, res) => {
  const { field, url } = req.body;
  if (!field || !url) {
    return res.status(400).json({ ok: false, error: 'Trūkst attēla vai lauka nosaukuma.' });
  }
  const content = await readContent();
  if (!setPath(content, field, url)) {
    return res.status(400).json({ ok: false, error: 'Nezināms lauks: ' + field });
  }
  await writeContent(content);
  res.json({ ok: true, url });
}));

app.post('/admin/api/video', requireAuthApi, asyncRoute(async (req, res) => {
  const { field, url } = req.body;
  if (!field || !url) {
    return res.status(400).json({ ok: false, error: 'Trūkst video vai lauka nosaukuma.' });
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
  if (!field) {
    return res.status(400).json({ ok: false, error: 'Trūkst lauka nosaukuma.' });
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

app.post('/admin/api/par-mums/team/add', requireAuthApi, asyncRoute(async (req, res) => {
  const content = await readContent();
  const page = content['par-mums'];
  if (!Array.isArray(page.teamMembers)) page.teamMembers = [];
  page.teamMembers.push({ name: 'Vārds Uzvārds', role: 'Amats', photo: null, phone: '', email: '' });
  await writeContent(content);
  res.json({ ok: true });
}));

app.post('/admin/api/par-mums/team/remove', requireAuthApi, asyncRoute(async (req, res) => {
  const memberIndex = Number(req.body.memberIndex);
  const content = await readContent();
  const page = content['par-mums'];
  if (!Array.isArray(page.teamMembers) || !page.teamMembers[memberIndex]) {
    return res.status(400).json({ ok: false, error: 'Komandas biedrs nav atrasts.' });
  }
  page.teamMembers.splice(memberIndex, 1);
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
