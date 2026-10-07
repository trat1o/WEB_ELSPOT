// Augšupielādēto failu drošība: formāta pārbaude pēc faila satura (nevis nosaukuma/MIME), attēlu pārkodēšana
// (noņem metadatus un iekļautu kaitīgu saturu), izmēra ierobežojumi, nejauši servera ģenerēti faila nosaukumi.
const crypto = require('crypto');
const sharp = require('sharp');

const MAX_PIXELS = 50 * 1000 * 1000;      // aizsardzība pret "dekompresijas bumbām"
const MAX_DIMENSION = 2400;               // attēlus samazinām līdz šim izmēram
const randomName = () => crypto.randomBytes(12).toString('hex');

const extOf = (name) => {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  return m ? '.' + m[1].toLowerCase() : '';
};

// Rādāmais nosaukums: bez ceļa, rindu pārtraukumiem un vadības rakstzīmēm.
function safeDisplayName(name) {
  return String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>"|?*]/g, '').slice(0, 120);
}

// ---- Administratora attēli (logo, ražotāji, kategoriju bildes) ----
const SVG_FORBIDDEN = /<!ENTITY|<!DOCTYPE|<script|<foreignObject|<image|<iframe|<use[^>]+href\s*=\s*["'](?!#)|href\s*=\s*["'](?!#)/i;

async function processAdminImage(file) {
  const ext = extOf(file.originalname);
  if (!['.jpg', '.jpeg', '.png', '.webp', '.svg'].includes(ext)) return { error: 'Atļauti tikai JPG, PNG, WEBP un SVG attēli.' };
  const buf = file.buffer;
  if (!buf || buf.length < 16) return { error: 'Fails ir tukšs vai bojāts.' };

  const head = buf.subarray(0, 16);
  const isJpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isPng = head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  const isSvg = ext === '.svg';

  if (isSvg) {
    if (buf.length > 1024 * 1024) return { error: 'SVG fails ir par lielu (maksimums 1 MB).' };
    const text = buf.toString('utf8');
    if (!/<svg[\s>]/i.test(text) || text.includes('\u0000')) return { error: 'Fails nav derīgs SVG.' };
    if (SVG_FORBIDDEN.test(text)) return { error: 'SVG satur nedrošus elementus (skripti, ārējas atsauces). Lūdzu, eksportē tīru SVG vai izmanto PNG.' };
  } else if (!(isJpg || isPng || isWebp)) {
    return { error: 'Faila saturs neatbilst attēla formātam.' };
  }

  try {
    let pipeline = sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error', ...(isSvg ? { density: 192 } : {}) });
    const meta = await pipeline.metadata();
    const allowed = isSvg ? ['svg'] : ['jpeg', 'png', 'webp'];
    if (!allowed.includes(meta.format)) return { error: 'Faila saturs neatbilst paplašinājumam.' };
    pipeline = pipeline.rotate().resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: !isSvg });
    let out, outExt, contentType;
    if (meta.format === 'jpeg') { out = await pipeline.jpeg({ quality: 86, mozjpeg: true }).toBuffer(); outExt = '.jpg'; contentType = 'image/jpeg'; }
    else if (meta.format === 'webp') { out = await pipeline.webp({ quality: 86 }).toBuffer(); outExt = '.webp'; contentType = 'image/webp'; }
    else { out = await pipeline.png({ compressionLevel: 9 }).toBuffer(); outExt = '.png'; contentType = 'image/png'; }
    return { buffer: out, ext: outExt, contentType, pathname: `uploads/img-${randomName()}${outExt}` };
  } catch (err) {
    return { error: 'Attēlu neizdevās droši apstrādāt (bojāts vai pārāk liels fails).' };
  }
}

// ---- Apmeklētāju pielikumi cenu pieprasījumiem ----
const ATTACHMENT_RULES = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.dwg': 'application/octet-stream',
  '.dxf': 'application/octet-stream',
};
const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_RULES).join(',');

async function processAttachment(file) {
  const ext = extOf(file.originalname);
  if (!ATTACHMENT_RULES[ext]) return { error: 'Neatbalstīts faila formāts. Atļauti: PDF, JPG, PNG, WEBP, DOCX, XLSX, DWG, DXF.' };
  const buf = file.buffer;
  if (!buf || buf.length < 8) return { error: 'Fails ir tukšs vai bojāts.' };
  const head = buf.subarray(0, 8);
  const pathname = `quote-attachments/${randomName()}${ext}`;

  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    const processed = await processAdminImage(file);   // tā pati pārbaude + pārkodēšana
    if (processed.error) return { error: processed.error };
    return { buffer: processed.buffer, contentType: processed.contentType, pathname: `quote-attachments/${randomName()}${processed.ext}` };
  }
  if (ext === '.pdf') {
    if (head.subarray(0, 5).toString('latin1') !== '%PDF-') return { error: 'Faila saturs neatbilst PDF formātam.' };
    const raw = buf.toString('latin1');
    if (/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)\b/.test(raw)) return { error: 'PDF fails satur aktīvu saturu un netika pieņemts. Lūdzu, nosūti to bez skriptiem/pielikumiem.' };
  } else if (ext === '.docx' || ext === '.xlsx') {
    if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) return { error: 'Faila saturs neatbilst Office formātam.' };
    const raw = buf.toString('latin1');
    if (!raw.includes('[Content_Types].xml')) return { error: 'Faila saturs neatbilst Office formātam.' };
    if (/vbaProject|macrosheets|activeX/i.test(raw)) return { error: 'Faili ar makro vai iegultiem objektiem netiek pieņemti.' };
  } else if (ext === '.dwg') {
    if (!/^AC10\d\d/.test(buf.subarray(0, 6).toString('latin1'))) return { error: 'Faila saturs neatbilst DWG formātam.' };
  } else if (ext === '.dxf') {
    const sample = buf.subarray(0, 4096);
    if (sample.includes(0) || !/SECTION/.test(sample.toString('latin1'))) return { error: 'Faila saturs neatbilst DXF formātam.' };
  }
  return { buffer: buf, contentType: ATTACHMENT_RULES[ext], pathname };
}

module.exports = { processAdminImage, processAttachment, safeDisplayName, ATTACHMENT_ACCEPT };
