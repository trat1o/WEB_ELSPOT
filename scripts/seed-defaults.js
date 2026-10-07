// Papildina datubāzē esošo saturu ar trūkstošajiem laukiem (Pakalpojumu lapa) un izlabo kartes koordinātes.
// Drošs palaist atkārtoti: esošās vērtības netiek pārrakstītas (izņemot nederīgas koordinātes).
require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

// ELSPOT birojs: Cesvaines iela 4, Rīga, LV-1073 (OpenStreetMap, ēkas precizitāte)
const OFFICE_LAT = '56.9296211';
const OFFICE_LNG = '24.2071313';

const PAKALPOJUMI_DEFAULTS = {
  heading: 'Palīdzam no aprēķina līdz piegādei objektā',
  intro: 'Papildus elektromateriālu pārdošanai piedāvājam pakalpojumus, kas atvieglo projekta plānošanu un īstenošanu.',
  items: [
    { title: 'Apgaismojuma aprēķins', image: null, icon: 'bulb', video: '/video/apgaismojums.mp4', poster: '/video/apgaismojums-ekas-kadrs.jpg', videoFit: 'contain' },
    { title: 'Tāmēšana', image: null, icon: 'estimate' },
    { title: 'Preču piegāde uz objektu', image: null, icon: 'truck' },
    { title: 'Kabeļu transportēšanas piekabes noma', image: null, icon: 'trailer', video: '/video/piekabe.mp4', poster: '/video/piekabe-poster.jpg' },
  ],
  noteHeading: 'Nepieciešams speciālista ieteikums?',
  noteText: 'Ja jums nepieciešams viens no tālāk minētajiem pakalpojumiem, griezieties pie mūsu speciālistiem — viņi sniegs padomu un ieteiks piemērotāko risinājumu jūsu objektam.',
  extras: [
    { title: 'Elektroinstalācijas darbi' },
    { title: 'Projektēšana' },
    { title: 'Elektriskie mērījumi' },
    { title: 'Sadalņu komplektēšana' },
  ],
};

const isNum = (v) => Number.isFinite(Number(String(v).trim().replace(',', '.'))) && String(v).trim() !== '';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Trūkst DATABASE_URL (.env)');
  const sql = neon(process.env.DATABASE_URL);

  let content;
  for (let i = 1; i <= 6; i++) {
    try {
      const rows = await sql`SELECT content FROM site_content WHERE id = 1`;
      content = rows[0].content;
      break;
    } catch (e) {
      if (i === 6) throw e;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  const changes = [];

  // Pakalpojumi: pievieno tikai trūkstošos laukus
  const p = content.pakalpojumi || (content.pakalpojumi = { title: 'Pakalpojumi' });
  if (!p.title) p.title = 'Pakalpojumi';
  for (const [key, value] of Object.entries(PAKALPOJUMI_DEFAULTS)) {
    if (p[key] === undefined) {
      p[key] = value;
      changes.push('pakalpojumi.' + key);
    }
  }

  // Kartes koordinātes: ja nav skaitļi (piem., ierakstīts "Links WAZE"), liekam biroja koordinātes
  const k = content.kontakti;
  if (k && (!isNum(k.mapLat) || !isNum(k.mapLng))) {
    k.mapLat = OFFICE_LAT;
    k.mapLng = OFFICE_LNG;
    changes.push('kontakti.mapLat/mapLng');
  }

  if (changes.length === 0) {
    console.log('Nekas nav jāmaina — viss jau ir kārtībā.');
    return;
  }
  await sql`UPDATE site_content SET content = ${JSON.stringify(content)}::jsonb WHERE id = 1`;
  console.log('Atjaunināts:', changes.join(', '));
}

main().catch((err) => {
  console.error('Kļūda:', err.message);
  process.exit(1);
});
