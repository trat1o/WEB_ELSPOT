require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Trūkst DATABASE_URL vides mainīgā (.env vai Vercel projekta iestatījumos).');
    process.exit(1);
  }
  const sql = neon(databaseUrl);

  await sql`
    CREATE TABLE IF NOT EXISTS site_content (
      id smallint PRIMARY KEY,
      content jsonb NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS quote_requests (
      id serial PRIMARY KEY,
      name text NOT NULL,
      contact text NOT NULL,
      message text,
      attachment_url text,
      attachment_original_name text,
      ip text,
      submitted_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS ip text`;
  await sql`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id serial PRIMARY KEY,
      ip text NOT NULL,
      attempted_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  console.log('Tabulas site_content, quote_requests un login_attempts gatavas.');

  const contentPath = path.join(__dirname, '..', 'data', 'content.json');
  if (fs.existsSync(contentPath)) {
    const content = JSON.parse(fs.readFileSync(contentPath, 'utf-8'));
    await sql`
      INSERT INTO site_content (id, content) VALUES (1, ${JSON.stringify(content)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content
    `;
    console.log('Saturs (data/content.json) pārcelts uz site_content tabulu.');
  } else {
    console.log('Nav atrasts data/content.json — izlaižam satura pārcelšanu.');
  }

  const quotesPath = path.join(__dirname, '..', 'data', 'quote-requests.json');
  if (fs.existsSync(quotesPath)) {
    const quotes = JSON.parse(fs.readFileSync(quotesPath, 'utf-8'));
    const attachmentsDir = path.join(__dirname, '..', 'data', 'quote-attachments');
    for (const q of quotes) {
      let attachmentUrl = null;
      if (q.attachment) {
        const localFile = path.join(attachmentsDir, q.attachment);
        if (fs.existsSync(localFile)) {
          const { put } = require('@vercel/blob');
          const buffer = fs.readFileSync(localFile);
          const blob = await put('quote-attachments/' + q.attachment, buffer, { access: 'public', addRandomSuffix: true });
          attachmentUrl = blob.url;
        }
      }
      await sql`
        INSERT INTO quote_requests (name, contact, message, attachment_url, attachment_original_name, submitted_at)
        VALUES (
          ${q.name}, ${q.contact}, ${q.message || null},
          ${attachmentUrl}, ${q.attachmentOriginalName || null},
          ${q.submittedAt || new Date().toISOString()}
        )
      `;
    }
    console.log(`Pārcelti ${quotes.length} cenu pieprasījumi uz quote_requests tabulu.`);
  } else {
    console.log('Nav atrasts data/quote-requests.json — vēl nav neviena cenu pieprasījuma, izlaižam.');
  }

  console.log('Migrācija pabeigta.');
}

main().catch((err) => {
  console.error('Migrācijas kļūda:', err);
  process.exit(1);
});
