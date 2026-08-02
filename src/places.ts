// Punti di interesse ancorati a una mappa: sedute, zone di conversazione,
// schede cliccabili e portali verso un'altra mappa.
//
// I punti stanno in un JSON per mappa (`/spots-<mappa>.json`). Se il file non
// c'e' la mappa resta vuota e nulla si rompe: e' un livello opzionale sopra la
// scena, non una dipendenza.
//
// L'editor (?edit=1) e' volutamente minimo: cammini dove vuoi il punto, premi
// un tasto, e alla fine scarichi il JSON. Niente gizmo, niente trascinamento —
// posizionare "stando li'" e' piu' veloce che mirare, e non richiede
// raycasting contro una heightfield.
import * as THREE from 'three'

export type SpotKind = 'seat' | 'zone' | 'poi' | 'portal'

export type Spot = {
  t: SpotKind
  x: number; y: number; z: number
  yaw?: number
  r?: number          // raggio, solo per le zone
  title?: string
  desc?: string
  img?: string
  price?: string
  link?: string
  map?: string        // destinazione, solo per i portali
}

const ACCENT = 0xe0a458

export class Places {
  spots: Spot[] = []
  private group = new THREE.Group()
  private mapId: string

  constructor(scene: THREE.Scene, mapId: string) {
    this.mapId = mapId
    scene.add(this.group)
  }

  async load() {
    try {
      const r = await fetch(`/spots-${this.mapId}.json`)
      if (r.ok) this.spots = await r.json()
    } catch { /* nessun punto per questa mappa */ }
    this.rebuild()
  }

  add(s: Spot) {
    this.spots.push(s)
    this.rebuild()
  }

  removeLast() {
    this.spots.pop()
    this.rebuild()
  }

  /** Rifa' tutta la grafica: i punti sono pochi, non vale la pena aggiornarli. */
  rebuild() {
    this.group.clear()
    for (const s of this.spots) this.group.add(this.build(s))
  }

  private build(s: Spot) {
    const g = new THREE.Group()
    g.position.set(s.x, s.y, s.z)
    if (s.t === 'zone') {
      // disco a terra: si vede da dentro e da fuori, non chiude la vista
      const m = new THREE.Mesh(
        new THREE.RingGeometry((s.r ?? 3) - 0.06, s.r ?? 3, 48),
        new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }),
      )
      m.rotation.x = -Math.PI / 2
      m.position.y = 0.03
      g.add(m)
    } else if (s.t === 'seat') {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.24, 0.34, 24),
        new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }),
      )
      m.rotation.x = -Math.PI / 2
      m.position.y = 0.03
      g.add(m)
    } else {
      // poi e portale: una colonna sottile, visibile da lontano anche al buio
      const h = s.t === 'portal' ? 3.2 : 1.4
      const col = new THREE.Mesh(
        new THREE.CylinderGeometry(s.t === 'portal' ? 0.42 : 0.06, s.t === 'portal' ? 0.42 : 0.06, h, 16, 1, true),
        new THREE.MeshBasicMaterial({
          color: s.t === 'portal' ? 0x8fd0ff : ACCENT,
          transparent: true, opacity: s.t === 'portal' ? 0.28 : 0.55,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      )
      col.position.y = h / 2
      g.add(col)
      if (s.title) g.add(this.label(s.title, h + 0.25))
    }
    return g
  }

  private label(text: string, y: number) {
    const c = document.createElement('canvas')
    c.width = 256; c.height = 64
    const x = c.getContext('2d')!
    x.fillStyle = 'rgba(0,0,0,0.55)'
    x.beginPath(); x.roundRect(4, 14, 248, 36, 18); x.fill()
    x.font = '600 22px ui-monospace, Consolas, monospace'
    x.fillStyle = '#efe9e1'; x.textAlign = 'center'; x.textBaseline = 'middle'
    x.fillText(text.slice(0, 18), 128, 33)
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), transparent: true, depthTest: false, depthWrite: false,
    }))
    sp.scale.set(1.3, 0.33, 1)
    sp.position.y = y
    sp.renderOrder = 9
    return sp
  }

  /** Il punto piu' vicino di un certo tipo entro `max`. */
  nearest(kind: SpotKind, x: number, z: number, max: number) {
    let best: Spot | null = null
    let bd = max
    for (const s of this.spots) {
      if (s.t !== kind) continue
      const d = Math.hypot(s.x - x, s.z - z)
      if (d < bd) { bd = d; best = s }
    }
    return best
  }

  /** true se le due posizioni stanno nella STESSA zona di conversazione. */
  sameZone(ax: number, az: number, bx: number, bz: number) {
    for (const s of this.spots) {
      if (s.t !== 'zone') continue
      const r = s.r ?? 3
      if (Math.hypot(s.x - ax, s.z - az) < r && Math.hypot(s.x - bx, s.z - bz) < r) return true
    }
    return false
  }

  toJSON() {
    return JSON.stringify(this.spots.map(s => ({
      ...s, x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2),
    })), null, 1)
  }

  download() {
    const b = new Blob([this.toJSON()], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(b)
    a.download = `spots-${this.mapId}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }
}

/** Marcatore del puntatore condiviso: un anello che pulsa dove qualcuno indica. */
export class Pointer {
  private mesh: THREE.Mesh
  private until = 0

  constructor(scene: THREE.Scene, color = ACCENT) {
    this.mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.3, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, depthTest: false }),
    )
    this.mesh.rotation.x = -Math.PI / 2
    this.mesh.renderOrder = 11
    scene.add(this.mesh)
  }

  show(x: number, y: number, z: number, seconds = 2.5) {
    this.mesh.position.set(x, y + 0.05, z)
    this.until = performance.now() + seconds * 1000
  }

  update() {
    const m = this.mesh.material as THREE.MeshBasicMaterial
    const left = this.until - performance.now()
    const t = performance.now() / 300
    m.opacity = left <= 0 ? 0 : Math.min(1, left / 600) * (0.55 + 0.35 * Math.sin(t))
    this.mesh.scale.setScalar(left > 0 ? 1 + 0.12 * Math.sin(t) : 1)
  }
}
