#!/usr/bin/env node
// Estrae la heightfield di una scena e la salva in JSON.
//
// _makecol.ts gira nel browser (gli serve il parser di Spark per leggere lo
// splat) e lascia il risultato su window.__HF: questo script apre la pagina,
// aspetta e scrive il file. Il browser deve essere "headed": in headless il
// rasterizzatore software non regge scene da milioni di gaussiane.
//
// Il dev server deve essere gia' in ascolto:  npm run dev
//
// Uso:
//   node tools/makehf.js /cap-light.splat 128 public/hf-cap.json
//   node tools/makehf.js /park.ply 128 public/hf-park.json y+        (forza l'asse su)
//   node tools/makehf.js /bonsai.splat 128 public/hf-bonsai.json ydown  (pre-inclina)
//
// Il 4o argomento: due caratteri ("y+", "z-") forzano l'asse verticale con ?up=,
// altrimenti e' un ?pretilt= ("ydown", "zup", ...). Serve sulle scene dove il
// rilevamento automatico rifiuta di raddrizzare perche' non trova un piano di
// suolo dominante.
import fs from 'node:fs';
import path from 'node:path';

// Playwright non e' una dipendenza del gioco: serve solo per aggiungere mappe,
// quindi si installa a parte invece di pesare su ogni npm install. L'import e'
// dinamico perche' il progetto e' ESM: uno statico fallirebbe prima di poter
// spiegare il perche'.
let chromium;
try { ({ chromium } = await import('playwright')) } catch {
  console.error('Serve Playwright per questo script:\n  npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const [splatUrl, G = '128', out, axis] = process.argv.slice(2);
const PORT = process.env.PORT ?? '4880';

if (!splatUrl) {
  console.error('uso: node tools/makehf.js <urlSplat> [G] [outJson] [up|pretilt]');
  process.exit(1);
}

// Git Bash su Windows riscrive un argomento che inizia con "/" in un percorso
// Windows (/scena.ply -> C:/Program Files/Git/scena.ply) PRIMA che node lo veda.
// Se riconosciamo quella forma teniamo solo la coda, cosi' lo script funziona
// sia con "/scena.ply" sia con "scena.ply" sia dal prompt di Windows.
const splat = '/' + splatUrl
  .replace(/^[A-Za-z]:[\\/].*?[\\/]Git[\\/]/i, '')
  .replace(/^\/+/, '');

const extra = axis
  ? `&${axis.length === 2 ? 'up' : 'pretilt'}=${encodeURIComponent(axis)}`
  : '';
const url = `http://localhost:${PORT}/_makecol.html?splat=${splat}&hf=${G}${extra}`;

const browser = await chromium.launch({ headless: false, args: ['--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

console.log(url);
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__HF || window.__ERR, null, { timeout: 600000 });

const err = await page.evaluate(() => window.__ERR);
if (err) {
  console.error('ERRORE:', err, errors);
  await browser.close();
  process.exit(1);
}

const hf = await page.evaluate(() => window.__HF);
const st = await page.evaluate(() => window.__STATS);
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(hf));
}

const o = st.orientation;
console.log(`\n${splat}  —  ${st.splats.toLocaleString('it-IT')} gaussiane`);
console.log(`  asse ${o.chosen.toUpperCase()}${o.sign > 0 ? '+' : '-'}  `
  + `rapporto ${o.ratio}x (soglia ${o.minRatio}x)  => `
  + (o.confident ? 'RADDRIZZA' : 'RIFIUTA, lascia com\'e\''));
for (const a of o.axes) {
  console.log(`    ${a.axis}: piccosita ${String(a.peakiness).padStart(7)}`
    + `  sopra ${a.above}  sotto ${a.below}${a.axis === o.chosen ? '  <— scelto' : ''}`);
}
console.log(`  heightfield ${st.G}x${st.G}: camminabile ${st.pctWalkable}%`
  + `  (celle muro ${st.totalCells - st.walkable}, quota muro ${st.wallLevel})`);
if (out) console.log(`  scritto: ${out}`);
if (errors.length) console.log('  errori:', errors);
await browser.close();
