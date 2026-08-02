import { defineConfig, type Plugin, type ResolvedConfig } from 'vite'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
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
])
const SCENE_EXT = /\.(ply|splat|spz|ksplat|rad)$/i

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
    chunkSizeWarningLimit: 1500,      // three + rapier + spark are simply big
  },
})
