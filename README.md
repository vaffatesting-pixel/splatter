# SPLATTER

Un gioco horror in prima persona ambientato dentro scene **Gaussian splat** reali:
cortili, attici, studi catturati con la fotogrammetria, esplorati al buio con una
torcia che si scarica. Cinque oggetti da raccogliere, cinque minuti, un'uscita.

**Live: https://splatter-ten.vercel.app** — funziona anche da telefono.

Gira nel browser: Vite + TypeScript + Three.js + [Spark](https://sparkjs.dev) per gli
splat, [Rapier](https://rapier.rs) per la fisica.

---

## Da dove viene

Questo repository nasce come fork di
**[icurtis1/splat-collider-builder](https://github.com/icurtis1/splat-collider-builder)**
di **Ian Curtis**, un editor che permette di disegnare volumi di collisione sopra
uno splat ed esportarli in `.glb`. Quel tool è ancora qui, intatto, in
`index.html` + `src/main.ts`: si apre in locale su `/index.html` e non è stato
modificato se non per accettare anche i `.ply`.

L'originale è distribuito con **licenza MIT, © 2026 Ian Curtis** — vedi
[LICENSE](LICENSE), che resta valida per tutto il codice ereditato.

Il gioco è ciò che è stato costruito sopra: `home.html`, `walk.html`,
`src/walk.ts`, `src/audio.ts`, `src/mobile.ts` e gli strumenti in `tools/`.

### Crediti degli asset

- **Scene**: Cortile Capitolino di David Fletcher, CC BY 4.0, via [SuperSplat](https://superspl.at) ·
  attico dal repository originale · bonsai e playroom dal dataset pubblico
  [dylanebert/3dgs](https://huggingface.co/datasets/dylanebert/3dgs)
- **Audio**: [Kenney RPG Audio](https://kenney.nl), CC0
- **Personaggio**: RobotExpressive di three.js, CC0

---

## In locale

```sh
npm install
npm run dev
```

- `http://localhost:4880/home.html` — le mappe, il punto d'ingresso del gioco
- `http://localhost:4880/walk.html?map=capitoline` — direttamente in una mappa
- `http://localhost:4880/index.html` — l'editor di collider originale

In locale il gioco carica le scene **piene**; in produzione carica sempre quelle
leggere (vedi sotto). Per provare in locale quelle leggere: `?quality=low`.

### Parametri utili di `walk.html`

| parametro | effetto |
|---|---|
| `?map=capitoline\|attic\|bonsai` | sceglie la mappa |
| `?quality=low\|high` | forza la variante leggera o piena |
| `?dark=0` | luce piena, niente torcia né timer: modalità esplorazione |
| `?fp=1` / `?fp=0` | prima o terza persona (`V` la commuta) |
| `?cull=` / `?fcull=0` | raggio di taglio per distanza · disattiva il taglio fuori campo |
| `?splat=&heightfield=&sx=&sy=&sz=` | scena e collisioni arbitrarie, per i test |

Comandi: `WASD` muovi, `Shift` corri, mouse guarda, `E` raccogli, `F` torcia,
`R` batteria di scorta, `V` vista. Su touch: joystick a sinistra, trascinamento a
destra, bottoni in basso a destra.

---

## Aggiungere una mappa nuova

Serve un `.ply` (3DGS binario) o un `.splat`. Il percorso completo è quattro passi;
i primi due si saltano se il file è già piccolo.

**0. Playwright**, che serve solo qui e non è una dipendenza del gioco:

```sh
npm i -D playwright && npx playwright install chromium
```

**1. Decimare**, se il file supera ~1 GB — un campionamento casuale uniforme, veloce,
solo per rendere trattabili i passi successivi:

```sh
python tools/decimate_ply.py public/scena.ply public/scena-2m.ply --target 2000000
```

**2. Potare per importanza** (opzionale, per la versione desktop). Il punteggio è
`sigmoid(opacità) × min(volume, volume_p90)`, applicato **dentro ogni voxel** così
nessuna zona si svuota:

```sh
python tools/prune_ply.py public/scena.ply public/scena-1m.ply --target 1000000 --mode voxel
```

**3. Costruire la variante leggera** per il telefono: pota *e* riscrive in `.splat`,
32 byte a gaussiana invece di 236. È questo passo a fare il peso, non la potatura:

```sh
python tools/mklight.py public/scena.ply public/scena-light.splat --target 400000
```

Punta ai **10-13 MB**. Sopra i ~40 MB il picco di memoria durante il parse mette a
rischio la scheda su iOS.

**4. Generare la heightfield**, cioè le collisioni. Il dev server deve essere acceso:

```sh
node tools/makehf.js /scena-light.splat 128 public/hf-scena.json
```

Poi misura la heightfield per decidere se la mappa è giocabile:

```sh
python tools/hfstats.py public/hf-scena.json
```

Le due misure che decidono sono **area connessa** (la zona camminabile più grande
tutta collegata, in unità reali) e **raggio libero** (quanto ci si allontana dal
muro più vicino nel punto più aperto). Il personaggio è una capsula di raggio
0.30: sotto 0.6 non passa fisicamente, sotto 1.0 non è giocabile. Lo script
stampa anche uno **spawn suggerito**, il punto più aperto della zona connessa.

`makehf` stampa l'asse verticale rilevato e la percentuale camminabile. Due cose
da guardare:

- se dice **RIFIUTA**, il rilevamento non ha trovato un piano di suolo dominante:
  rilancia forzando l'asse, es. `node tools/makehf.js /scena.ply 128 public/hf.json y+`
  (per i `.ply` INRIA/COLMAP, che sono Y-down, di solito serve `ydown` come pre-inclinazione)
- sotto il **40% camminabile** la scena raramente è giocabile: sono catture a 360°
  attorno a un soggetto, non stanze complete

**5. Registrare la mappa** in `MAPS` dentro `src/walk.ts` (splat pieno, `light`,
heightfield, punto di partenza) e in `MAPS` dentro `src/home.ts` (peso e metriche
mostrate sulla card). Lo spawn va scelto in una zona piana e connessa: se il
personaggio ci nasce dentro un muro, non è un bug della fisica ma dello spawn.

**6. Se la mappa è nuova, aggiungerla alla whitelist** `SHIP_SCENES` in
`vite.config.ts`, altrimenti la build la esclude dal pacchetto.

---

## Deploy

Il deploy porta online **solo le varianti leggere**: i `.ply` pieni vanno da 225 MB
a 1,1 GB, tutti oltre il limite di 100 MB per file di Vercel. Tre meccanismi
indipendenti lo garantiscono, e sono ridondanti apposta:

- `.gitignore` e `.vercelignore` tengono i file pesanti fuori da repository e upload
- il plugin `dropHeavyScenes` in `vite.config.ts` cancella da `dist/` ogni scena non
  in whitelist
- in produzione il gioco sceglie sempre la variante leggera (`import.meta.env.PROD`),
  con un fallback se il file richiesto non risponde

```sh
npm run build      # verifica locale: stampa cosa spedisce e quanto scarta
npx vercel --prod  # deploy
```

Nota su Vercel: il filesystem statico viene consultato **prima** dei rewrite, quindi
un `index.html` nell'output vincerebbe la rotta `/` e servirebbe l'editor invece del
gioco. Per questo `index.html` non viene costruito e resta uno strumento locale.

---

## Struttura

```
src/walk.ts      il gioco: fisica, torcia, obiettivi, HUD, prima/terza persona
src/mobile.ts    joystick, sguardo a trascinamento, bottoni, rotazione schermo
src/audio.ts     Web Audio: passi, scricchiolii, drone reattivo, torcia
src/home.ts      le card delle mappe
src/_makecol.ts  rilevamento dell'asse verticale e generazione della heightfield
src/main.ts      l'editor di collider originale, non toccato
tools/           decimazione, potatura, variante leggera, heightfield
public/          scene, heightfield, audio, miniature
```

Le scene pesanti **non sono nel repository**: restano sul disco di chi le ha
scaricate. Online e su GitHub ci sono solo le varianti leggere.

## Licenza

MIT — vedi [LICENSE](LICENSE). Il codice ereditato è © 2026 Ian Curtis; le aggiunte
seguono la stessa licenza. Gli asset hanno le loro, elencate sopra.
