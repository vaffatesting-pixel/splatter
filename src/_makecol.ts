// TEMPORARY helper — detects scene orientation, then builds a Rapier heightfield
// from the splat cloud. Not part of the app. Safe to delete.
import * as THREE from 'three'
import { SplatMesh, SplatFileType } from '@sparkjsdev/spark'

declare global {
  interface Window { __HF?: unknown; __STATS?: unknown; __ERR?: string }
}

// Kaspersky's injected script wraps window.fetch and chokes on large bodies;
// XHR is not wrapped, so use it for the big splat download.
function loadBytes(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url, true)
    xhr.responseType = 'arraybuffer'
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve(xhr.response)
      : reject(new Error(`${url} → HTTP ${xhr.status}`)))
    xhr.onerror = () => reject(new Error(`${url} → network error`))
    xhr.send()
  })
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]
}

/**
 * Work out which axis is vertical and which way is up, from the points alone.
 *
 * A ground plane is a large set of points sharing one coordinate, so along the
 * vertical axis the distribution has a sharp spike; along horizontal axes the
 * points are spread out. We score each axis by how concentrated its densest
 * slice is, then decide the sign by where the bulk of the scene sits relative
 * to that slice — a scene stands above its ground, not below it.
 */
function detectUp(px: number[], py: number[], pz: number[]) {
  const axes = [
    { name: 'x', v: px },
    { name: 'y', v: py },
    { name: 'z', v: pz },
  ]
  const BINS = 400
  const scored = axes.map(({ name, v }) => {
    const sorted = [...v].sort((a, b) => a - b)
    // trim outliers so a few floaters cannot stretch the range
    const lo = percentile(sorted, 0.005), hi = percentile(sorted, 0.995)
    const span = hi - lo || 1
    const bins = new Float64Array(BINS)
    let counted = 0
    for (const val of v) {
      if (val < lo || val > hi) continue
      bins[Math.min(BINS - 1, Math.floor(((val - lo) / span) * BINS))]++
      counted++
    }
    // densest slice = candidate ground level
    let peak = 0, peakBin = 0
    for (let i = 0; i < BINS; i++) if (bins[i] > peak) { peak = bins[i]; peakBin = i }
    const peakVal = lo + ((peakBin + 0.5) / BINS) * span
    // concentration: how much denser the peak is than a uniform spread
    const peakiness = (peak / counted) * BINS
    let above = 0, below = 0
    for (const val of v) (val > peakVal ? above++ : below++)
    return { name, peakiness, peakVal, above, below, span }
  })

  const ranked = [...scored].sort((a, b) => b.peakiness - a.peakiness)
  const [best, second] = ranked
  const ratio = best.peakiness / (second.peakiness || 1e-9)

  // A real ground plane towers over the other axes. If it doesn't, there is no
  // dominant plane to trust — refuse to rotate rather than guess silently.
  const MIN_RATIO = 2
  const confident = ratio >= MIN_RATIO
  const sign = best.above >= best.below ? 1 : -1     // scene sits on the up side
  const up = new THREE.Vector3(
    best.name === 'x' ? sign : 0,
    best.name === 'y' ? sign : 0,
    best.name === 'z' ? sign : 0,
  )
  const quat = confident
    ? new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 1, 0))
    : new THREE.Quaternion()                          // identity: leave as-is
  return {
    up, quat, detail: scored, chosen: best.name, sign,
    ratio: +ratio.toFixed(2), confident, minRatio: MIN_RATIO, forced: false,
  }
}

async function main() {
  const q = new URLSearchParams(location.search)
  const url = q.get('splat') ?? '/attic.spz'
  const name = url.split('/').pop() ?? 'attic.spz'
  const ext = name.split('.').pop()?.toLowerCase()
  const buf = await loadBytes(url)
  const mesh = new SplatMesh({
    fileBytes: buf,
    fileName: name,
    fileType: ext === 'ply' ? SplatFileType.PLY
      : ext === 'rad' ? SplatFileType.RAD
        : ext === 'splat' ? SplatFileType.SPLAT
          : ext === 'ksplat' ? SplatFileType.KSPLAT
            : SplatFileType.SPZ,
  })
  await mesh.initialized

  const px: number[] = [], py: number[] = [], pz: number[] = []
  mesh.forEachSplat((_i, center, _s, _q, opacity) => {
    if (opacity < 0.35) return
    px.push(center.x); py.push(center.y); pz.push(center.z)
  })

  // Manual orientation override (?pretilt=zup|zdown|xup|ydown). Two uses:
  // testing that the detector finds a non-±Y axis, and forcing the orientation
  // of files whose convention we know (INRIA .splat/.ply are Y-down) when the
  // detector refuses. It is composed into the saved quaternion, so the visual
  // splat stays aligned with the heightfield.
  const pretilt = q.get('pretilt')
  const tq = new THREE.Quaternion()
  if (pretilt) {
    const ax = new THREE.Vector3(1, 0, 0), az = new THREE.Vector3(0, 0, 1)
    if (pretilt === 'zup') tq.setFromAxisAngle(ax, Math.PI / 2)      // up -> +Z
    else if (pretilt === 'zdown') tq.setFromAxisAngle(ax, -Math.PI / 2) // up -> -Z
    else if (pretilt === 'xup') tq.setFromAxisAngle(az, -Math.PI / 2)   // up -> +X
    else if (pretilt === 'ydown') tq.setFromAxisAngle(ax, Math.PI)      // up -> -Y
    const t = new THREE.Vector3()
    for (let i = 0; i < px.length; i++) {
      t.set(px[i], py[i], pz[i]).applyQuaternion(tq)
      px[i] = t.x; py[i] = t.y; pz[i] = t.z
    }
  }

  // 1. find "up" and rotate every point so that +Y is up.
  // ?up=y+|y-|x+|x-|z+|z- forces the axis when detection picks the wrong one
  // (long tunnels: the two side walls can out-peak the floor).
  const forced = q.get('up')
  const orient = detectUp(px, py, pz)
  if (forced && /^[xyz][+-]$/.test(forced)) {
    const sign = forced[1] === '-' ? -1 : 1
    const up = new THREE.Vector3(
      forced[0] === 'x' ? sign : 0,
      forced[0] === 'y' ? sign : 0,
      forced[0] === 'z' ? sign : 0,
    )
    orient.up.copy(up)
    orient.quat.setFromUnitVectors(up, new THREE.Vector3(0, 1, 0))
    orient.chosen = forced[0]
    orient.sign = sign
    orient.confident = true
    orient.forced = true
  }
  const v = new THREE.Vector3()
  for (let i = 0; i < px.length; i++) {
    v.set(px[i], py[i], pz[i]).applyQuaternion(orient.quat)
    px[i] = v.x; py[i] = v.y; pz[i] = v.z
  }

  // 2. extents of the upright scene
  const xs = [...px].sort((a, b) => a - b)
  const ys = [...py].sort((a, b) => a - b)
  const zs = [...pz].sort((a, b) => a - b)
  const minX = percentile(xs, 0.02), maxX = percentile(xs, 0.98)
  const minZ = percentile(zs, 0.02), maxZ = percentile(zs, 0.98)
  const loY = percentile(ys, 0.01), hiY = percentile(ys, 0.99)

  // 3. heightfield: one ground height per grid vertex.
  // Rapier wants a (G x G) matrix in COLUMN-MAJOR order; rows -> Z, cols -> X.
  const G = Number(q.get('hf') ?? 128)
  const MIN_SAMPLES = Number(q.get('minpts') ?? 8)
  const cols: number[][] = Array.from({ length: G * G }, () => [])
  for (let i = 0; i < px.length; i++) {
    if (px[i] < minX || px[i] > maxX || pz[i] < minZ || pz[i] > maxZ) continue
    const jx = Math.round(((px[i] - minX) / (maxX - minX)) * (G - 1))
    const iz = Math.round(((pz[i] - minZ) / (maxZ - minZ)) * (G - 1))
    cols[iz * G + jx].push(py[i])
  }
  const raw: (number | null)[] = cols.map(arr => {
    if (arr.length < MIN_SAMPLES) return null
    arr.sort((a, b) => a - b)
    return percentile(arr, 0.05)          // ground = low percentile of the column
  })
  const holes = raw.filter(x => x === null).length

  // Median over a 3x3 window: damps the cell-to-cell vertical noise (one cell
  // catching ground, its neighbour catching the base of a bush) without
  // inventing anything — a cell with no evidence stays null.
  const smooth: (number | null)[] = raw.map((val, ci) => {
    if (val === null) return null
    const iz = Math.floor(ci / G), jx = ci % G
    const win: number[] = []
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const z2 = iz + dz, x2 = jx + dx
      if (z2 < 0 || z2 >= G || x2 < 0 || x2 >= G) continue
      const n = raw[z2 * G + x2]
      if (n !== null) win.push(n)
    }
    win.sort((a, b) => a - b)
    return win[(win.length - 1) >> 1]
  })

  // No interpolation: a cell without evidence becomes an unclimbable wall, so the
  // character can never walk onto invented ground and never falls through a gap.
  // The outer ring is forced to wall too, sealing the edge of the covered area.
  const WALL = hiY + 25
  const heights = new Array<number>(G * G)
  let walkable = 0
  for (let iz = 0; iz < G; iz++) for (let jx = 0; jx < G; jx++) {
    const edge = iz === 0 || jx === 0 || iz === G - 1 || jx === G - 1
    const val = smooth[iz * G + jx]
    const isWall = edge || val === null
    if (!isWall) walkable++
    heights[iz + jx * G] = isWall ? WALL : (val as number)   // column-major: row + col * G
  }

  // optional probe: ?probe=x,z;x,z — ground level around each point measured by
  // the MODE of the local height histogram (deliberately a different criterion
  // from the percentile the heightfield uses, so the check is not circular)
  const probeArg = q.get('probe')
  if (probeArg) {
    const R = Number(q.get('probeR') ?? 1.5)
    const out = probeArg.split(';').filter(Boolean).map(pair => {
      const [sx, sz] = pair.split(',').map(Number)
      const col: number[] = []
      for (let i = 0; i < px.length; i++) {
        if (Math.abs(px[i] - sx) <= R && Math.abs(pz[i] - sz) <= R) col.push(py[i])
      }
      if (col.length < 20) return { x: sx, z: sz, n: col.length, ground: null }
      const BIN = 0.25
      const hist = new Map<number, number>()
      for (const y of col) { const k = Math.round(y / BIN); hist.set(k, (hist.get(k) ?? 0) + 1) }
      let bk = 0, bn = -1
      for (const [k, c] of hist) if (c > bn) { bn = c; bk = k }
      col.sort((a, b) => a - b)
      return {
        x: sx, z: sz, n: col.length,
        ground: +(bk * BIN).toFixed(2),       // densest slice = walkable surface
        modePts: bn,
        p05: +percentile(col, 0.05).toFixed(2),
      }
    })
    ;(window as unknown as Record<string, unknown>).__PROBE = out
  }

  // total rotation applied to the points: first the manual tilt, then detection
  const qt = orient.quat.clone().multiply(tq)
  window.__HF = {
    G, nrows: G - 1, ncols: G - 1, heights,
    scale: { x: maxX - minX, y: 1, z: maxZ - minZ },
    center: { x: (minX + maxX) / 2, y: 0, z: (minZ + maxZ) / 2 },
    quaternion: { x: qt.x, y: qt.y, z: qt.z, w: qt.w },
    holes, totalCells: G * G, walkable, wallLevel: WALL,
    orientationConfident: orient.confident,
  }
  window.__STATS = {
    splats: px.length, G, holes, totalCells: G * G, walkable,
    pctWalkable: +(100 * walkable / (G * G)).toFixed(1),
    wallLevel: +WALL.toFixed(2),
    orientation: {
      chosen: orient.chosen, sign: orient.sign,
      ratio: orient.ratio, confident: orient.confident, minRatio: orient.minRatio,
      up: { x: orient.up.x, y: orient.up.y, z: orient.up.z },
      axes: orient.detail.map(d => ({
        axis: d.name, peakiness: +d.peakiness.toFixed(1),
        peakVal: +d.peakVal.toFixed(2), above: d.above, below: d.below,
      })),
    },
    uprightExtents: { minX, maxX, minZ, maxZ, loY, hiY },
  }
}

main().catch(e => { window.__ERR = String(e?.stack ?? e?.message ?? e) })
