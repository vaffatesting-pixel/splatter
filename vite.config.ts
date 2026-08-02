import { defineConfig, type Plugin, type ResolvedConfig } from 'vite'
import { readdirSync, statSync, unlinkSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// package.json is "type": "module", so __dirname does not exist here
const root = fileURLToPath(new URL('.', import.meta.url))

// Only these scene files go online. Everything else in public/ is either a
// working file (the 1.1 GB source .ply, the pruning experiments) or a build we
// keep for desktop only — and every one of them is over Vercel's 100 MB per
// file limit anyway. A whitelist, not a blacklist: adding a new experiment to
// public/ must never silently add 450 MB to a deploy.
const SHIP_SCENES = new Set([
  'cap-light.splat', 'attic.spz', 'bonsai-light.splat', 'truck-light.splat',
  'train-light.splat', 'garden-light.splat',
])
const SCENE_EXT = /\.(ply|splat|spz|ksplat|rad)$/i

/** byte totali di una cartella, ricorsiva */
function dirSize(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    n += e.isDirectory() ? dirSize(p) : statSync(p).size
  }
  return n
}

function dropHeavyScenes(): Plugin {
  let cfg: ResolvedConfig
  return {
    name: 'drop-heavy-scenes',
    apply: 'build',
    configResolved(c) { cfg = c },
    closeBundle() {
      const out = resolve(cfg.root, cfg.build.outDir)
      let freed = 0
      const kept: string[] = []
      // public/_src e' il banco di lavoro: sorgenti scaricate, zip, FBX, texture
      // a 4K. Vite copia tutto public/ senza chiedere, quindi la cartella va
      // tolta in blocco — non basta filtrare per estensione.
      const src = join(out, '_src')
      try {
        freed += dirSize(src)
        rmSync(src, { recursive: true, force: true })
      } catch { /* non c'era */ }
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name)
          if (statSync(p).isDirectory()) { walk(p); continue }
          if (!SCENE_EXT.test(name)) continue
          if (SHIP_SCENES.has(name)) { kept.push(name); continue }
          freed += statSync(p).size
          unlinkSync(p)
        }
      }
      try { walk(out) } catch { return }
      const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`
      cfg.logger.info(
        `\n  scene spedite: ${kept.sort().join(', ') || 'nessuna'}` +
        `\n  scartate dal pacchetto: ${mb(freed)}\n`)
    },
  }
}

export default defineConfig({
  plugins: [dropHeavyScenes()],
  build: {
    // Without this Vite would build index.html alone and the game would not
    // exist in dist/ at all.
    rollupOptions: {
      output: {
        // rolldown vuole una funzione, non una mappa
        manualChunks(id: string) {
          if (id.includes('node_modules/three/')) return 'three'
          if (id.includes('rapier3d')) return 'rapier'
          if (id.includes('sparkjsdev')) return 'spark'
          return undefined
        },
      },
      input: {
        home: resolve(root, 'home.html'),
        walk: resolve(root, 'walk.html'),
        // index.html (the collider builder) is deliberately NOT built: Vercel
        // checks the filesystem before it applies rewrites, so an index.html in
        // the output would win "/" and serve the authoring tool instead of the
        // game. The builder stays a local tool — it works on files you pick off
        // your own disk anyway.
      },
    },
    // Un solo bundle da 7,5 MB bloccava il primo render finche' non era tutto
    // scaricato. Separandoli, three e spark si scaricano in parallelo e restano
    // in cache fra un deploy e l'altro: cambiando il codice di gioco il
    // browser riscarica solo quello.
    chunkSizeWarningLimit: 2500,
  },
})
