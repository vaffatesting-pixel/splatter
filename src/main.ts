import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { dyno, type GsplatModifier, SparkRenderer, SplatMesh, SplatFileType } from '@sparkjsdev/spark'


const canvas = document.querySelector<HTMLCanvasElement>('#c')!
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!
const fileInput = document.querySelector<HTMLInputElement>('#file-splat')!
const loadExampleBtn = document.querySelector<HTMLButtonElement>('#load-example-splat')!
const exportBtn = document.querySelector<HTMLButtonElement>('#export-glb')!
function setStatus(text: string, isError = false) {
  statusEl.textContent = text
  statusEl.classList.toggle('error', isError)
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace

const scene = new THREE.Scene()
const FOG_NEAR = 5
const FOG_FAR = 60
scene.fog = new THREE.Fog(0x383838, FOG_NEAR, FOG_FAR)

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 12000)
camera.position.set(3, 2, 5)

const spark = new SparkRenderer({
  renderer,
  transparent: true,
  depthTest: true,
  depthWrite: true,
  onDirty: () => {
    /* continuous render loop; hook available for future throttling */
  },
})
spark.sortRadial = false
scene.add(spark)

const hemi = new THREE.HemisphereLight(0xcfd4dc, 0x2a2a30, 0.82)
scene.add(hemi)
const dir = new THREE.DirectionalLight(0xffffff, 0.9)
dir.position.set(4, 10, 6)
scene.add(dir)

/** Shift-move snap in world units (independent of grid line spacing). */
const TRANSFORM_SHIFT_GRID_SNAP = 1
const TRANSFORM_SHIFT_ROT_SNAP = THREE.MathUtils.degToRad(5)
/** Uniform scale steps while Shift is held (e.g. 0.05 → 5% increments). */
const TRANSFORM_SHIFT_SCALE_SNAP = 0.05

let sceneBg = 0x383838
let gridExtent = 1000
let gridDivisions = 2000
const GRID_COLOR1 = 0x4d4d4d
const GRID_COLOR2 = 0x4d4d4d
let grid: THREE.GridHelper | undefined

const AXIS_LINE_Y = 0.03
const axisXMat = new THREE.LineBasicMaterial({ color: 0xff3333 })
const axisZMat = new THREE.LineBasicMaterial({ color: 0x3388ff })
let axisXLine: THREE.Line
let axisZLine: THREE.Line

function applySceneBackground() {
  renderer.setClearColor(sceneBg, 1)
  if (!scene.background || !(scene.background instanceof THREE.Color)) {
    scene.background = new THREE.Color(sceneBg)
  } else {
    scene.background.setHex(sceneBg)
  }
  document.documentElement.style.setProperty('--scene', `#${sceneBg.toString(16).padStart(6, '0')}`)
}

function applyFog() {
  if (scene.fog instanceof THREE.Fog) {
    scene.fog.color.setHex(sceneBg)
    scene.fog.near = FOG_NEAR
    scene.fog.far = FOG_FAR
  } else {
    scene.fog = new THREE.Fog(sceneBg, FOG_NEAR, FOG_FAR)
  }
}

function rebuildGroundAxes() {
  const half = gridExtent * 0.5
  const gx = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-half, AXIS_LINE_Y, 0),
    new THREE.Vector3(half, AXIS_LINE_Y, 0),
  ])
  const gz = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, AXIS_LINE_Y, -half),
    new THREE.Vector3(0, AXIS_LINE_Y, half),
  ])
  if (axisXLine) {
    axisXLine.geometry.dispose()
    axisZLine.geometry.dispose()
    axisXLine.geometry = gx
    axisZLine.geometry = gz
  } else {
    axisXLine = new THREE.Line(gx, axisXMat)
    axisZLine = new THREE.Line(gz, axisZMat)
    scene.add(axisXLine, axisZLine)
  }
}

function rebuildGrid() {
  if (grid) {
    scene.remove(grid)
    grid.dispose()
  }
  const ext = THREE.MathUtils.clamp(Math.round(gridExtent), 20, 5000)
  const div = THREE.MathUtils.clamp(Math.round(gridDivisions), 2, 2000)
  gridExtent = ext
  gridDivisions = div
  grid = new THREE.GridHelper(ext, div, GRID_COLOR1, GRID_COLOR2)
  scene.add(grid)
  rebuildGroundAxes()
}

const originDot = new THREE.Mesh(
  new THREE.SphereGeometry(0.07, 10, 8),
  new THREE.MeshBasicMaterial({ color: 0xffffff }),
)
originDot.position.set(0, AXIS_LINE_Y + 0.02, 0)
scene.add(originDot)

applySceneBackground()
applyFog()
rebuildGrid()

const colliderRoot = new THREE.Group()
colliderRoot.name = 'Colliders'
scene.add(colliderRoot)

/** Collider and splat render/depth parameters — all tunable at runtime. */
const colliderDebug = {
  // ── fill (solid mesh) ──────────────────────────────────────────────────────
  fillOpacity: 0.25,
  fillAlphaHash: false,
  fillPolyOffset: -0.5,
  fillDepthWrite: false,
  fillRenderOrder: 3,
  // ── edges (rim wireframe) ──────────────────────────────────────────────────
  edgeOpacity: 0.72,
  edgeDepthTest: true,
  edgeRenderOrder: 4,
  // ── x-ray pass (GreaterDepth — shows through occluders) ───────────────────
  xrayOpacity: 0.12,
  xrayRenderOrder: 2,
}
/** Splat render order — adjust to put splat before or after collider passes. */
let splatRenderOrder = 1
/** Splat opacity multiplier (0-1), applied via dyno worldModifier. */
let splatOpacityValue = 1.0
let splatBrightnessValue = 1.0
let splatTintAmountValue = 0.0
let splatTransparentValue = true
let splatDepthTestValue = true
let splatDepthWriteValue = true
let splatSortRadialValue = false
let splatFalloffValue = 1.0
let splatHighlightEnabledValue = true
let splatHighlightAmountValue = 0.7

const splatOpacityMult = dyno.dynoFloat(splatOpacityValue)
const splatBrightnessMult = dyno.dynoFloat(splatBrightnessValue)
const splatTintAmount = dyno.dynoFloat(splatTintAmountValue)
const splatTintColor = dyno.dynoVec3(new THREE.Vector3(1, 1, 1))
const splatHighlightEnabled = dyno.dynoBool(splatHighlightEnabledValue)
const splatHighlightActive = dyno.dynoBool(false)
const splatHighlightIsSphere = dyno.dynoBool(false)
const splatHighlightIsCylinder = dyno.dynoBool(false)
const splatHighlightAmount = dyno.dynoFloat(splatHighlightAmountValue)
const splatHighlightColor = dyno.dynoVec3(new THREE.Vector3(1, 0.82, 0.08))
const splatHighlightCenter = dyno.dynoVec3(new THREE.Vector3(0, 0, 0))
const splatHighlightAxisX = dyno.dynoVec3(new THREE.Vector3(1, 0, 0))
const splatHighlightAxisY = dyno.dynoVec3(new THREE.Vector3(0, 1, 0))
const splatHighlightAxisZ = dyno.dynoVec3(new THREE.Vector3(0, 0, 1))
const splatHighlightHalfSize = dyno.dynoVec3(new THREE.Vector3(0, 0, 0))

function makeSplatDisplayModifier(): GsplatModifier {
  return dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {
      const { center, rgb, opacity } = dyno.splitGsplat(gsplat!).outputs
      const newOpacity = dyno.mul(opacity, splatOpacityMult)
      const brightRgb = dyno.mul(rgb, splatBrightnessMult)
      const tintedRgb = dyno.add(dyno.mul(brightRgb, dyno.sub(dyno.dynoFloat(1), splatTintAmount)), dyno.mul(splatTintColor, splatTintAmount))

      const rel = dyno.sub(center, splatHighlightCenter)
      const localX = dyno.abs(dyno.dot(rel, splatHighlightAxisX))
      const localY = dyno.abs(dyno.dot(rel, splatHighlightAxisY))
      const localZ = dyno.abs(dyno.dot(rel, splatHighlightAxisZ))
      const halfParts = dyno.split(splatHighlightHalfSize).outputs
      const insideX = dyno.lessThan(localX, halfParts.x!)
      const insideY = dyno.lessThan(localY, halfParts.y!)
      const insideZ = dyno.lessThan(localZ, halfParts.z!)
      const boxInside = dyno.and(dyno.and(insideX, insideY), insideZ)

      const safeHalfX = dyno.max(halfParts.x!, dyno.dynoFloat(0.0001))
      const safeHalfY = dyno.max(halfParts.y!, dyno.dynoFloat(0.0001))
      const safeHalfZ = dyno.max(halfParts.z!, dyno.dynoFloat(0.0001))
      const nx = dyno.div(localX, safeHalfX)
      const ny = dyno.div(localY, safeHalfY)
      const nz = dyno.div(localZ, safeHalfZ)
      const nx2 = dyno.mul(nx, nx)
      const ny2 = dyno.mul(ny, ny)
      const nz2 = dyno.mul(nz, nz)

      const sphereInside = dyno.lessThan(dyno.add(dyno.add(nx2, ny2), nz2), dyno.dynoFloat(1))
      const cylinderInside = dyno.and(
        dyno.lessThan(dyno.add(nx2, nz2), dyno.dynoFloat(1)),
        insideY,
      )
      const roundInside = dyno.select(splatHighlightIsSphere, sphereInside, cylinderInside)
      const insideBounds = dyno.select(
        dyno.or(splatHighlightIsSphere, splatHighlightIsCylinder),
        roundInside,
        boxInside,
      )
      const shouldHighlight = dyno.and(dyno.and(splatHighlightEnabled, splatHighlightActive), insideBounds)
      const highlightedRgb = dyno.add(
        dyno.mul(tintedRgb, dyno.sub(dyno.dynoFloat(1), splatHighlightAmount)),
        dyno.mul(splatHighlightColor, splatHighlightAmount),
      )
      const newRgb = dyno.select(shouldHighlight, highlightedRgb, tintedRgb)

      return { gsplat: dyno.combineGsplat({ gsplat: gsplat!, rgb: newRgb, opacity: newOpacity }) }
    },
  )
}

function hexFromColorInput(el: HTMLInputElement): number {
  const v = el.value.trim()
  if (!v.startsWith('#') || v.length < 7) return 0
  return parseInt(v.slice(1, 7), 16)
}

function initSceneGridGui() {
  const bgEl = document.querySelector<HTMLInputElement>('#gui-scene-bg')
  const sizeEl = document.querySelector<HTMLInputElement>('#gui-grid-size')
  const divEl = document.querySelector<HTMLInputElement>('#gui-grid-divisions')
  if (!bgEl || !sizeEl || !divEl) return

  const syncInputs = () => {
    bgEl.value = `#${sceneBg.toString(16).padStart(6, '0')}`
    sizeEl.value = String(gridExtent)
    divEl.value = String(gridDivisions)
  }

  const applyFromGui = () => {
    sceneBg = hexFromColorInput(bgEl)
    gridExtent = THREE.MathUtils.clamp(parseInt(sizeEl.value, 10) || gridExtent, 20, 5000)
    gridDivisions = THREE.MathUtils.clamp(parseInt(divEl.value, 10) || gridDivisions, 2, 2000)
    applySceneBackground()
    applyFog()
    rebuildGrid()
    syncInputs()
  }

  bgEl.addEventListener('input', applyFromGui)
  sizeEl.addEventListener('change', applyFromGui)
  divEl.addEventListener('change', applyFromGui)

  syncInputs()
}

initSceneGridGui()

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

const MIN_BOX = 0.05
const MAX_BOX_H = 200

const addDraftRoot = new THREE.Group()
addDraftRoot.name = 'AddBoxDraft'
scene.add(addDraftRoot)

/** Pixels the pointer must travel before a mousedown+drag is treated as a draw gesture. */
const DRAG_THRESHOLD_PX = 8
/** Client-space coordinate where the current LMB drag started. */
const dragStart = new THREE.Vector2()

type DrawPhase = 'idle' | 'dragging_footprint' | 'adjusting_height'
let drawPhase: DrawPhase = 'idle'
type PrimitiveShape = 'box' | 'sphere' | 'cylinder'
let activeShape: PrimitiveShape = 'box'
const addCorner0 = new THREE.Vector3()
const addCorner1 = new THREE.Vector3()
type AddBaseSpec = {
  cx: number
  cz: number
  width: number
  depth: number
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  radius: number   // inscribed-circle radius; primary for sphere / cylinder
}
let addBaseSpec: AddBaseSpec | null = null
let addHeightM = MIN_BOX
/** Screen Y (clientY) when height-adjust phase began. */
let heightStartScreenY = 0
/**
 * How many screen pixels correspond to 1 world-unit of height at the box's depth.
 * Computed by projecting the box centre and box centre+1m into screen space.
 */
let heightPixelsPerMeter = 100

/**
 * Three orthogonal great-circle rings for sphere wireframe overlay.
 * radius=1 for draft (scaled at runtime); pass actual radius for committed colliders.
 */
function buildSphereRingGeometry(radius: number): THREE.BufferGeometry {
  const SEGS = 32
  const positions: number[] = []
  function ring(fn: (a: number) => [number, number, number]) {
    for (let i = 0; i < SEGS; i++) {
      const a0 = (i / SEGS) * Math.PI * 2
      const a1 = ((i + 1) / SEGS) * Math.PI * 2
      const [ax, ay, az] = fn(a0)
      const [bx, by, bz] = fn(a1)
      positions.push(ax, ay, az, bx, by, bz)
    }
  }
  ring(a => [Math.cos(a) * radius, 0, Math.sin(a) * radius])
  ring(a => [Math.cos(a) * radius, Math.sin(a) * radius, 0])
  ring(a => [0, Math.cos(a) * radius, Math.sin(a) * radius])
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3))
  return geom
}

/** Rebuild a BufferGeometry as a horizontal circle ring on the ground (Y = 0.02). */
const CIRCLE_DRAFT_SEGS = 48
function updateCircleGeom(geom: THREE.BufferGeometry, radius: number) {
  const pts = new Float32Array(CIRCLE_DRAFT_SEGS * 3)
  for (let i = 0; i < CIRCLE_DRAFT_SEGS; i++) {
    const a = (i / CIRCLE_DRAFT_SEGS) * Math.PI * 2
    pts[i * 3]     = Math.cos(a) * radius
    pts[i * 3 + 1] = 0.02
    pts[i * 3 + 2] = Math.sin(a) * radius
  }
  geom.setAttribute('position', new THREE.BufferAttribute(pts, 3))
  geom.computeBoundingSphere()
}

/** Interior cross-hatch on each face (rim stays on `EdgesGeometry`). Larger = denser grid. */
const COLLIDER_BOX_GRID_DIVS = 4

/**
 * Line segment pairs for a grid on all six faces of an axis-aligned box centered at the origin,
 * excluding the outer rim (handled separately by EdgesGeometry).
 */
function buildBoxFaceGridGeometry(width: number, height: number, depth: number, divs: number): THREE.BufferGeometry {
  const positions: number[] = []
  const hx = width * 0.5
  const hy = height * 0.5
  const hz = depth * 0.5
  if (divs < 2) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(0), 3))
    return g
  }

  function addLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    positions.push(ax, ay, az, bx, by, bz)
  }

  // Z± faces (xy planes)
  for (let i = 1; i < divs; i++) {
    const ty = (i / divs) * height - hy
    addLine(-hx, ty, hz, hx, ty, hz)
    addLine(-hx, ty, -hz, hx, ty, -hz)
    const tx = (i / divs) * width - hx
    addLine(tx, -hy, hz, tx, hy, hz)
    addLine(tx, -hy, -hz, tx, hy, -hz)
  }
  // X± faces (yz planes)
  for (let i = 1; i < divs; i++) {
    const ty = (i / divs) * height - hy
    addLine(hx, ty, -hz, hx, ty, hz)
    addLine(-hx, ty, -hz, -hx, ty, hz)
    const tz = (i / divs) * depth - hz
    addLine(hx, -hy, tz, hx, hy, tz)
    addLine(-hx, -hy, tz, -hx, hy, tz)
  }
  // Y± faces (xz planes)
  for (let i = 1; i < divs; i++) {
    const tx = (i / divs) * width - hx
    addLine(tx, hy, -hz, tx, hy, hz)
    addLine(tx, -hy, -hz, tx, -hy, hz)
    const tz = (i / divs) * depth - hz
    addLine(-hx, hy, tz, hx, hy, tz)
    addLine(-hx, -hy, tz, hx, -hy, tz)
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3))
  return geom
}

const draftFootGeom = new THREE.BufferGeometry()
const draftFootLine = new THREE.LineLoop(
  draftFootGeom,
  new THREE.LineBasicMaterial({ color: 0x6ee7b7, depthTest: true }),
)
const draftBoxGeom = new THREE.BoxGeometry(1, 1, 1)
const draftBoxMat = new THREE.MeshStandardMaterial({
  color: 0x5eead4,
  transparent: true,
  opacity: Math.min(0.95, colliderDebug.fillOpacity + 0.12),
  metalness: 0.05,
  roughness: 0.7,
  depthWrite: false,
  alphaHash: colliderDebug.fillAlphaHash,
  polygonOffset: true,
  polygonOffsetFactor: colliderDebug.fillPolyOffset,
  polygonOffsetUnits: colliderDebug.fillPolyOffset,
})
const draftBoxMesh = new THREE.Mesh(draftBoxGeom, draftBoxMat)
/** Interior grid: softer so the outer rim reads as the silhouette. */
const draftGridMat = new THREE.LineBasicMaterial({
  color: 0x6a9e96,
  transparent: true,
  opacity: 0.55,
  depthTest: false,
  depthWrite: false,
})
const draftBoxGrid = new THREE.LineSegments(
  buildBoxFaceGridGeometry(1, 1, 1, COLLIDER_BOX_GRID_DIVS),
  draftGridMat,
)
draftBoxGrid.renderOrder = 10000
draftBoxGrid.raycast = () => {}
/** Bright outer 12 edges — reads as the box outline over splats. */
const draftRimMat = new THREE.LineBasicMaterial({
  color: 0xe8fffc,
  transparent: true,
  opacity: 1,
  depthTest: false,
  depthWrite: false,
})
const draftBoxRim = new THREE.LineSegments(new THREE.EdgesGeometry(draftBoxGeom), draftRimMat)
draftBoxRim.renderOrder = 10001
draftBoxRim.raycast = () => {}
draftFootLine.visible = false
draftBoxMesh.visible = false
draftBoxGrid.visible = false
draftBoxRim.visible = false
addDraftRoot.add(draftFootLine)
addDraftRoot.add(draftBoxMesh)
addDraftRoot.add(draftBoxGrid)
addDraftRoot.add(draftBoxRim)

// ── Round-shape drafts (sphere / cylinder) ────────────────────────────────
const draftCircleGeom = new THREE.BufferGeometry()
const draftCircleLine = new THREE.LineLoop(
  draftCircleGeom,
  new THREE.LineBasicMaterial({ color: 0x6ee7b7, depthTest: true }),
)
draftCircleLine.visible = false

const draftSphereMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1, 16, 12),
  draftBoxMat, // shared draft material
)
draftSphereMesh.visible = false
draftSphereMesh.renderOrder = 6
const draftSphereRimMat = new THREE.LineBasicMaterial({
  color: 0xe8fffc, transparent: true, opacity: 1, depthTest: false, depthWrite: false,
})
const draftSphereRim = new THREE.LineSegments(buildSphereRingGeometry(1), draftSphereRimMat)
draftSphereRim.renderOrder = 10001
draftSphereRim.raycast = () => {}
draftSphereRim.visible = false

const draftCylMesh = new THREE.Mesh(
  new THREE.CylinderGeometry(1, 1, 1, 24, 1),
  draftBoxMat, // shared draft material
)
draftCylMesh.visible = false
draftCylMesh.renderOrder = 6
const draftCylRimMat = new THREE.LineBasicMaterial({
  color: 0xe8fffc, transparent: true, opacity: 1, depthTest: false, depthWrite: false,
})
const draftCylRim = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.CylinderGeometry(1, 1, 1, 16, 1)),
  draftCylRimMat,
)
draftCylRim.renderOrder = 10001
draftCylRim.raycast = () => {}
draftCylRim.visible = false

addDraftRoot.add(draftCircleLine)
addDraftRoot.add(draftSphereMesh, draftSphereRim)
addDraftRoot.add(draftCylMesh, draftCylRim)

function setFootprintLine(spec: { minX: number; maxX: number; minZ: number; maxZ: number }) {
  const y = 0.02
  const pos = new Float32Array([
    spec.minX,
    y,
    spec.minZ,
    spec.maxX,
    y,
    spec.minZ,
    spec.maxX,
    y,
    spec.maxZ,
    spec.minX,
    y,
    spec.maxZ,
  ])
  draftFootGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  draftFootGeom.computeBoundingSphere()
}

function cornersToRawRect(
  a: THREE.Vector3,
  b: THREE.Vector3,
): { minX: number; maxX: number; minZ: number; maxZ: number; rw: number; rd: number; cx: number; cz: number } {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minZ = Math.min(a.z, b.z)
  const maxZ = Math.max(a.z, b.z)
  const rw = maxX - minX
  const rd = maxZ - minZ
  return { minX, maxX, minZ, maxZ, rw, rd, cx: (minX + maxX) * 0.5, cz: (minZ + maxZ) * 0.5 }
}

function rawRectToSpec(raw: ReturnType<typeof cornersToRawRect>): AddBaseSpec {
  const width = Math.max(raw.rw, MIN_BOX)
  const depth = Math.max(raw.rd, MIN_BOX)
  return {
    cx: raw.cx, cz: raw.cz,
    width, depth,
    minX: raw.minX, maxX: raw.maxX,
    minZ: raw.minZ, maxZ: raw.maxZ,
    radius: Math.max(Math.min(width, depth) * 0.5, MIN_BOX),
  }
}

/** For sphere / cylinder: first click = center, drag endpoint = rim. */
function cornersToCircleSpec(center: THREE.Vector3, edge: THREE.Vector3): AddBaseSpec {
  const dx = edge.x - center.x
  const dz = edge.z - center.z
  const radius = Math.max(Math.sqrt(dx * dx + dz * dz), MIN_BOX)
  return {
    cx: center.x, cz: center.z,
    radius,
    width: radius * 2, depth: radius * 2,
    minX: center.x - radius, maxX: center.x + radius,
    minZ: center.z - radius, maxZ: center.z + radius,
  }
}

function syncDraftBoxDecorations() {
  draftBoxGrid.position.copy(draftBoxMesh.position)
  draftBoxGrid.scale.copy(draftBoxMesh.scale)
  draftBoxGrid.visible = draftBoxMesh.visible
  draftBoxRim.position.copy(draftBoxMesh.position)
  draftBoxRim.scale.copy(draftBoxMesh.scale)
  draftBoxRim.visible = draftBoxMesh.visible
}

/** Derived spec for the current drag state (null when not applicable). */
function getDraftSpec(): AddBaseSpec | null {
  if (addBaseSpec) return addBaseSpec
  if (drawPhase !== 'dragging_footprint') return null
  return activeShape === 'box'
    ? rawRectToSpec(cornersToRawRect(addCorner0, addCorner1))
    : cornersToCircleSpec(addCorner0, addCorner1)
}

function hidAllDrafts() {
  draftFootLine.visible = false
  draftBoxMesh.visible = false
  draftBoxGrid.visible = false
  draftBoxRim.visible = false
  draftCircleLine.visible = false
  draftSphereMesh.visible = false
  draftSphereRim.visible = false
  draftCylMesh.visible = false
  draftCylRim.visible = false
}

function updateDraftVisual() {
  if (drawPhase === 'idle') { hidAllDrafts(); return }

  const spec = getDraftSpec()
  if (!spec) { hidAllDrafts(); return }

  if (activeShape === 'box') {
    draftCircleLine.visible = false
    draftSphereMesh.visible = false; draftSphereRim.visible = false
    draftCylMesh.visible = false;    draftCylRim.visible = false

    setFootprintLine(spec)
    draftFootLine.visible = true
    draftBoxMesh.visible = true

    if (drawPhase === 'dragging_footprint') {
      draftBoxMesh.position.set(spec.cx, MIN_BOX * 0.5, spec.cz)
      draftBoxMesh.scale.set(spec.width, MIN_BOX, spec.depth)
    } else if (addBaseSpec) {
      const absH = Math.max(Math.abs(addHeightM), MIN_BOX)
      const centerY = (addHeightM >= 0 ? absH : -absH) * 0.5
      draftBoxMesh.position.set(addBaseSpec.cx, centerY, addBaseSpec.cz)
      draftBoxMesh.scale.set(addBaseSpec.width, absH, addBaseSpec.depth)
    }
    syncDraftBoxDecorations()

  } else if (activeShape === 'sphere') {
    draftFootLine.visible = false
    draftBoxMesh.visible = false; draftBoxGrid.visible = false; draftBoxRim.visible = false
    draftCylMesh.visible = false;  draftCylRim.visible = false
    if (drawPhase !== 'dragging_footprint') { hidAllDrafts(); return }

    const r = spec.radius
    updateCircleGeom(draftCircleGeom, r)
    draftCircleLine.position.set(spec.cx, 0, spec.cz)
    draftCircleLine.visible = true

    draftSphereMesh.position.set(spec.cx, r, spec.cz)
    draftSphereMesh.scale.setScalar(r)
    draftSphereMesh.visible = true
    draftSphereRim.position.copy(draftSphereMesh.position)
    draftSphereRim.scale.copy(draftSphereMesh.scale)
    draftSphereRim.visible = true

  } else { // cylinder
    draftFootLine.visible = false
    draftBoxMesh.visible = false; draftBoxGrid.visible = false; draftBoxRim.visible = false
    draftSphereMesh.visible = false; draftSphereRim.visible = false

    const r = spec.radius
    updateCircleGeom(draftCircleGeom, r)
    draftCircleLine.position.set(spec.cx, 0, spec.cz)
    draftCircleLine.visible = true

    if (drawPhase === 'dragging_footprint') {
      draftCylMesh.position.set(spec.cx, MIN_BOX * 0.5, spec.cz)
      draftCylMesh.scale.set(r, MIN_BOX, r)
    } else if (addBaseSpec) {
      const absH = Math.max(Math.abs(addHeightM), MIN_BOX)
      const centerY = (addHeightM >= 0 ? absH : -absH) * 0.5
      draftCylMesh.position.set(addBaseSpec.cx, centerY, addBaseSpec.cz)
      draftCylMesh.scale.set(r, absH, r)
    }
    draftCylMesh.visible = true
    draftCylRim.position.copy(draftCylMesh.position)
    draftCylRim.scale.copy(draftCylMesh.scale)
    draftCylRim.visible = true
  }
  updateSplatHighlightBounds()
}

function clearDraft() {
  canvas.removeEventListener('pointermove', onFootprintDragMove)
  window.removeEventListener('pointermove', onHeightAdjustMove)
  drawPhase = 'idle'
  addBaseSpec = null
  hidAllDrafts()
  updateSplatHighlightBounds()
  canvas.style.cursor = ''  // let hover logic take over
}

// ── Hover cursor ─────────────────────────────────────────────────────────────
const _hoverPt = new THREE.Vector3()

function updateCursorForHover(clientX: number, clientY: number) {
  // Skip while any drag / look / phase is active — cursor is managed there
  if (drawPhase !== 'idle' || navLookPointerId !== null || transform.dragging) return

  // Gizmo handle highlighted? TransformControls updates transform.axis on its own
  // pointermove listener (registered before ours), so this is just a property read.
  if (transform.object !== undefined && transform.axis !== null) {
    canvas.style.cursor = 'pointer'
    return
  }

  // Single raycast against colliders — cheap: bounding-sphere rejection + simple box geometry
  pointer.x = (clientX / window.innerWidth) * 2 - 1
  pointer.y = -(clientY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(pointer, camera)

  if (raycaster.intersectObjects(colliderRoot.children, true).length > 0) {
    canvas.style.cursor = 'pointer'
    return
  }

  // Ground plane check — pure math, no geometry
  canvas.style.cursor = raycaster.ray.intersectPlane(groundPlane, _hoverPt) !== null
    ? 'crosshair'
    : ''
}

/**
 * Compute how many screen pixels equal 1 world-unit of height at the box centre.
 * We project the box base and a point 1m above it into NDC, then convert to pixels.
 * This makes the height drag feel identical regardless of camera angle or distance.
 */
function computeHeightPixelsPerMeter(cx: number, cz: number): number {
  const base = new THREE.Vector3(cx, 0, cz).project(camera)
  const top  = new THREE.Vector3(cx, 1, cz).project(camera)
  // NDC Y increases upward; screen Y increases downward.
  // Pixels moved up on screen for 1m = (top.y - base.y) * halfHeight.
  const pxPerM = (top.y - base.y) * (window.innerHeight * 0.5)
  return Math.max(pxPerM, 8) // floor: at least 8 px / m to stay responsive
}

function beginHeightAdjust(startClientY: number) {
  addHeightM = 0
  heightStartScreenY = startClientY
  heightPixelsPerMeter = computeHeightPixelsPerMeter(addBaseSpec!.cx, addBaseSpec!.cz)
  drawPhase = 'adjusting_height'
  canvas.style.cursor = 'ns-resize'
  window.addEventListener('pointermove', onHeightAdjustMove)
  updateDraftVisual()
  setStatus('Up = above ground · Down = below · click to confirm')
}

function onHeightAdjustMove(ev: PointerEvent) {
  if (drawPhase !== 'adjusting_height' || !addBaseSpec) return
  // Screen Y decreases as mouse moves up → positive = above ground, negative = below
  const screenDeltaUp = heightStartScreenY - ev.clientY
  addHeightM = THREE.MathUtils.clamp(screenDeltaUp / heightPixelsPerMeter, -MAX_BOX_H, MAX_BOX_H)
  updateDraftVisual()
}

function onFootprintDragMove(ev: PointerEvent) {
  if (drawPhase !== 'dragging_footprint') return
  if (!rayToGround(ev.clientX, ev.clientY, addCorner1)) return
  updateDraftVisual()
}

function commitAddFromDraft() {
  if (!addBaseSpec) { clearDraft(); return }
  let group: THREE.Group
  if (activeShape === 'sphere') {
    const radius = Math.max(addBaseSpec.radius, MIN_BOX)
    group = createColliderSphere(radius)
    group.position.set(addBaseSpec.cx, radius, addBaseSpec.cz) // center sits on ground
  } else if (activeShape === 'cylinder') {
    const absH = Math.max(Math.abs(addHeightM), MIN_BOX)
    const centerY = (addHeightM >= 0 ? absH : -absH) * 0.5
    group = createColliderCylinder(addBaseSpec.radius, absH)
    group.position.set(addBaseSpec.cx, centerY, addBaseSpec.cz)
  } else {
    const absH = Math.max(Math.abs(addHeightM), MIN_BOX)
    const centerY = (addHeightM >= 0 ? absH : -absH) * 0.5
    group = createColliderBox(addBaseSpec.width, absH, addBaseSpec.depth)
    group.position.set(addBaseSpec.cx, centerY, addBaseSpec.cz)
  }
  registerCollider(group)
  colliderRoot.add(group)
  selectCollider(group)
  clearDraft()
  setStatus('')
}

function rayToGround(clientX: number, clientY: number, target: THREE.Vector3): boolean {
  pointer.x = (clientX / window.innerWidth) * 2 - 1
  pointer.y = -(clientY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  return raycaster.ray.intersectPlane(groundPlane, target) !== null
}

const orbit = new OrbitControls(camera, canvas)
orbit.enabled = false

const navMove = { forward: 0, back: 0, left: 0, right: 0 }
let NAV_FLY_SPEED = 8
/** Navigate + Shift + WASD: extra fly speed multiplier. */
const NAV_FLY_SHIFT_MULT = 5.5
const NAV_LOOK_SENS = 0.0028
let navLookPointerId: number | null = null
let navYaw = 0
let navPitch = 0
const navEuler = new THREE.Euler(0, 0, 0, 'YXZ')


function teardownNavLook() {
  window.removeEventListener('pointermove', onNavLookMove)
  window.removeEventListener('pointerup', onNavLookEnd)
  window.removeEventListener('pointercancel', onNavLookEnd)
  if (navLookPointerId != null) {
    try {
      canvas.releasePointerCapture(navLookPointerId)
    } catch {
      /* ignore */
    }
    navLookPointerId = null
  }
}

function onNavLookMove(ev: PointerEvent) {
  if (ev.pointerId !== navLookPointerId) return
  navYaw -= ev.movementX * NAV_LOOK_SENS
  navPitch -= ev.movementY * NAV_LOOK_SENS
  navPitch = THREE.MathUtils.clamp(navPitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02)
  navEuler.set(navPitch, navYaw, 0, 'YXZ')
  camera.quaternion.setFromEuler(navEuler)
}

function onNavLookEnd(ev: PointerEvent) {
  if (ev.pointerId !== navLookPointerId) return
  teardownNavLook()
}

function startNavLook(ev: PointerEvent) {
  teardownNavLook()
  navEuler.setFromQuaternion(camera.quaternion, 'YXZ')
  navPitch = navEuler.x
  navYaw = navEuler.y
  navLookPointerId = ev.pointerId
  try {
    canvas.setPointerCapture(ev.pointerId)
  } catch {
    /* ignore */
  }
  ev.preventDefault()
  window.addEventListener('pointermove', onNavLookMove)
  window.addEventListener('pointerup', onNavLookEnd)
  window.addEventListener('pointercancel', onNavLookEnd)
}

/** Tracks Shift for fly boost (keyboard + pointer while transforming). */
let navigateFlyShiftHeld = false

function updateNavFlyMove(dt: number) {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  const move = new THREE.Vector3()
  if (navMove.forward) move.add(forward)
  if (navMove.back) move.sub(forward)
  if (navMove.right) move.add(right)
  if (navMove.left) move.sub(right)
  if (move.lengthSq() > 0) {
    const boost = navigateFlyShiftHeld
    const speed = NAV_FLY_SPEED * (boost ? NAV_FLY_SHIFT_MULT : 1)
    move.normalize().multiplyScalar(speed * dt)
    camera.position.add(move)
  }
}

const transform = new TransformControls(camera, canvas)
transform.setSize(0.85)
scene.add(transform.getHelper())

let transformSpace: 'world' | 'local' = 'world'

function applyTransformSpace() {
  transform.setSpace(transformSpace)
  const label = document.querySelector('#gizmo-space-label')
  if (label) label.textContent = transformSpace === 'world' ? 'World' : 'Local'
}

/** Non-identity rotation → local gizmo aligns with the box; axis-aligned → world. */
function defaultTransformSpaceForCollider(group: THREE.Group): 'world' | 'local' {
  const q = group.quaternion
  const imSq = q.x * q.x + q.y * q.y + q.z * q.z
  return imSq > 1e-6 ? 'local' : 'world'
}

applyTransformSpace()

let shiftConstraintSnapActive = false

function setTransformSnapsForShift(shift: boolean) {
  if (shift === shiftConstraintSnapActive) return
  shiftConstraintSnapActive = shift
  if (shift) {
    transform.setTranslationSnap(TRANSFORM_SHIFT_GRID_SNAP)
    transform.setRotationSnap(TRANSFORM_SHIFT_ROT_SNAP)
    transform.setScaleSnap(TRANSFORM_SHIFT_SCALE_SNAP)
  } else {
    transform.setTranslationSnap(null)
    transform.setRotationSnap(null)
    transform.setScaleSnap(null)
  }
}

function syncTransformConstraintSnapsFromKeyboard(ev: KeyboardEvent) {
  navigateFlyShiftHeld = ev.getModifierState('Shift')
  setTransformSnapsForShift(navigateFlyShiftHeld)
}

let selected: THREE.Group | null = null
const splatHighlightLocalBox = new THREE.Box3()
const splatHighlightSize = new THREE.Vector3()
const splatHighlightScale = new THREE.Vector3()
const splatHighlightQuat = new THREE.Quaternion()
const splatHighlightPos = new THREE.Vector3()
const splatHighlightAxisXWorld = new THREE.Vector3()
const splatHighlightAxisYWorld = new THREE.Vector3()
const splatHighlightAxisZWorld = new THREE.Vector3()
const splatHighlightHalfWorld = new THREE.Vector3()

function setDynoVec3Value(target: { value: THREE.Vector3 }, value: THREE.Vector3) {
  target.value.x = value.x
  target.value.y = value.y
  target.value.z = value.z
}

function getSplatHighlightMesh(): THREE.Mesh | null {
  if (drawPhase !== 'idle') {
    if (activeShape === 'box' && draftBoxMesh.visible) return draftBoxMesh
    if (activeShape === 'sphere' && draftSphereMesh.visible) return draftSphereMesh
    if (activeShape === 'cylinder' && draftCylMesh.visible) return draftCylMesh
  }
  return (selected?.getObjectByName('colliderSolid') as THREE.Mesh | undefined) ?? null
}

function getSplatHighlightShape(): PrimitiveShape {
  if (drawPhase !== 'idle') return activeShape
  if (selected?.name === 'ColliderSphere') return 'sphere'
  if (selected?.name === 'ColliderCylinder') return 'cylinder'
  return 'box'
}

function updateSplatHighlightBounds() {
  const source = getSplatHighlightMesh()
  if (!source || !splatHighlightEnabledValue) {
    splatHighlightActive.value = false
    return
  }

  source.updateWorldMatrix(true, false)
  const geom = source.geometry
  if (!geom) {
    splatHighlightActive.value = false
    return
  }

  if (!geom.boundingBox) geom.computeBoundingBox()
  if (!geom.boundingBox) {
    splatHighlightActive.value = false
    return
  }

  source.matrixWorld.decompose(splatHighlightPos, splatHighlightQuat, splatHighlightScale)
  splatHighlightLocalBox.copy(geom.boundingBox)
  splatHighlightLocalBox.getSize(splatHighlightSize)
  splatHighlightHalfWorld.set(
    Math.abs(splatHighlightSize.x * splatHighlightScale.x) * 0.5,
    Math.abs(splatHighlightSize.y * splatHighlightScale.y) * 0.5,
    Math.abs(splatHighlightSize.z * splatHighlightScale.z) * 0.5,
  )

  splatHighlightAxisXWorld.set(1, 0, 0).applyQuaternion(splatHighlightQuat).normalize()
  splatHighlightAxisYWorld.set(0, 1, 0).applyQuaternion(splatHighlightQuat).normalize()
  splatHighlightAxisZWorld.set(0, 0, 1).applyQuaternion(splatHighlightQuat).normalize()

  setDynoVec3Value(splatHighlightCenter, splatHighlightPos)
  setDynoVec3Value(splatHighlightAxisX, splatHighlightAxisXWorld)
  setDynoVec3Value(splatHighlightAxisY, splatHighlightAxisYWorld)
  setDynoVec3Value(splatHighlightAxisZ, splatHighlightAxisZWorld)
  setDynoVec3Value(splatHighlightHalfSize, splatHighlightHalfWorld)
  const shape = getSplatHighlightShape()
  splatHighlightIsSphere.value = shape === 'sphere'
  splatHighlightIsCylinder.value = shape === 'cylinder'
  splatHighlightActive.value = true
}

let boxCounter = 0
type HierarchyMeta = { name: string; hidden: boolean; locked: boolean }
const hierarchyMeta = new Map<THREE.Group, HierarchyMeta>()

type ColliderClipboard = {
  shapeType: PrimitiveShape
  width: number
  height: number
  depth: number
  radius: number
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  scale: THREE.Vector3
}
let colliderClipboard: ColliderClipboard | null = null
const pasteNudgeWorld = new THREE.Vector3()

/** OrbitControls grabs the camera each frame in box mode; never repoint it at the selection here. */
function syncTransformEnabled() {
  transform.enabled = transform.object !== undefined
}

transform.addEventListener('mouseDown', () => {
  orbit.enabled = false
})
transform.addEventListener('mouseUp', () => {
  /* orbit stays disabled */
})
transform.addEventListener('objectChange', updateSplatHighlightBounds)

window.addEventListener('pointermove', (ev) => {
  if (!transform.dragging) return
  if (isTypingInField()) return
  navigateFlyShiftHeld = ev.shiftKey
  setTransformSnapsForShift(ev.shiftKey)
})

window.addEventListener('blur', () => {
  navigateFlyShiftHeld = false
  setTransformSnapsForShift(false)
})

syncTransformEnabled()

let currentSplat: SplatMesh | null = null

function removeSplat() {
  if (!currentSplat) return
  scene.remove(currentSplat)
  currentSplat.dispose()
  currentSplat = null
}

function frameCameraToSplat(mesh: SplatMesh) {
  const box = mesh.getBoundingBox(true)
  if (box.isEmpty()) return
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3()).length()
  camera.position.copy(center).add(new THREE.Vector3(size * 0.55, size * 0.35, size * 0.55))
  camera.near = Math.max(0.01, size / 2000)
  camera.far = Math.max(12000, size * 20)
  camera.updateProjectionMatrix()
  camera.lookAt(center)
  // Sync free-look state so RMB drag immediately continues from the new angle
  navEuler.setFromQuaternion(camera.quaternion, 'YXZ')
  navPitch = navEuler.x
  navYaw = navEuler.y
}

/** Keep splats early, colliders + draft overlays later (stable vs transparent sort). */
function reorderSceneAfterSplat() {
  if (colliderRoot.parent === scene) scene.attach(colliderRoot)
  if (addDraftRoot.parent === scene) scene.attach(addDraftRoot)
}

async function loadSplatFromBuffer(buf: ArrayBuffer, fileName: string): Promise<boolean> {
  removeSplat()
  const ext = fileName.split('.').pop()?.toLowerCase()
  const opts: ConstructorParameters<typeof SplatMesh>[0] = {
    fileBytes: buf,
    fileName,
  }

  if (ext === 'spz') {
    opts.fileType = SplatFileType.SPZ
    opts.lod = true
  } else if (ext === 'rad') {
    opts.fileType = SplatFileType.RAD
  } else if (ext === 'ply') {
    opts.fileType = SplatFileType.PLY
  } else {
    setStatus('.spz, .rad or .ply only.', true)
    return false
  }

  setStatus('Loading…')
  const mesh = new SplatMesh(opts)
  currentSplat = mesh
  scene.add(mesh)

  try {
    await mesh.initialized
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true)
    scene.remove(mesh)
    mesh.dispose()
    currentSplat = null
    return false
  }

  // Apply reactive opacity modifier so the splat opacity slider works at runtime
  splatOpacityMult.value = splatOpacityValue
  mesh.worldModifier = makeSplatDisplayModifier()

  frameCameraToSplat(mesh)
  reorderSceneAfterSplat()
  setStatus('')
  return true
}

async function loadSplatFile(file: File) {
  const buf = await file.arrayBuffer()
  await loadSplatFromBuffer(buf, file.name)
}

async function loadExampleSplat() {
  loadExampleBtn.disabled = true
  try {
    const res = await fetch('/attic.spz')
    if (!res.ok) {
      setStatus(`Example splat missing (${res.status}).`, true)
      return
    }
    const buf = await res.arrayBuffer()
    await loadSplatFromBuffer(buf, 'attic.spz')
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true)
  } finally {
    loadExampleBtn.disabled = false
  }
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0]
  fileInput.value = ''
  if (f) void loadSplatFile(f)
})

loadExampleBtn.addEventListener('click', () => {
  void loadExampleSplat()
})

type GizmoMode = 'translate' | 'rotate' | 'scale'
type ScaleAxisLock = 'x' | 'y' | 'z' | null

function resetTransformAxisVisibility() {
  transform.showX = true
  transform.showY = true
  transform.showZ = true
}

function applyScaleAxisLock(lock: ScaleAxisLock) {
  if (lock === null) {
    resetTransformAxisVisibility()
    return
  }
  transform.showX = lock === 'x'
  transform.showY = lock === 'y'
  transform.showZ = lock === 'z'
}

let scaleAxisLock: ScaleAxisLock = null

function syncGizmoModeButtons(mode: GizmoMode) {
  document.querySelectorAll('#gizmo-mode button').forEach((b) => {
    const btn = b as HTMLButtonElement
    btn.classList.toggle('active', btn.dataset.mode === mode)
  })
}

function setGizmoMode(mode: GizmoMode, opts?: { scaleLock?: ScaleAxisLock; fromScaleHotkey?: boolean }) {
  const fromScaleHotkey = opts?.fromScaleHotkey ?? false
  if (mode !== 'scale') {
    scaleAxisLock = null
    resetTransformAxisVisibility()
  } else if (opts?.scaleLock !== undefined) {
    scaleAxisLock = opts.scaleLock
    applyScaleAxisLock(scaleAxisLock)
  } else if (fromScaleHotkey && transform.mode === 'scale') {
    scaleAxisLock = null
    resetTransformAxisVisibility()
  } else {
    scaleAxisLock = null
    resetTransformAxisVisibility()
  }
  transform.setMode(mode)
  syncGizmoModeButtons(mode)
}

document.querySelector('#gizmo-mode')?.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest('button')
  if (!btn) return
  const mode = btn.dataset.mode as GizmoMode
  setGizmoMode(mode)
})

function createColliderBox(w: number, h: number, d: number): THREE.Group {
  const group = new THREE.Group()
  group.name = 'ColliderBox'

  const geom = new THREE.BoxGeometry(w, h, d)
  const mat = new THREE.MeshStandardMaterial({
    color: 0x5eead4,
    transparent: true,
    opacity: colliderDebug.fillOpacity,
    metalness: 0.1,
    roughness: 0.65,
    depthWrite: false,
    alphaHash: colliderDebug.fillAlphaHash,
    polygonOffset: true,
    polygonOffsetFactor: colliderDebug.fillPolyOffset,
    polygonOffsetUnits: colliderDebug.fillPolyOffset,
  })
  const solid = new THREE.Mesh(geom, mat)
  solid.name = 'colliderSolid'
  solid.userData.isCollider = true
  solid.renderOrder = 6

  const rimMat = new THREE.LineBasicMaterial({
    color: 0xe5fffb,
    transparent: true,
    opacity: 1,
    depthTest: true,
    depthWrite: false,
  })
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), rimMat)
  edges.name = 'colliderEdges'
  edges.renderOrder = 12
  edges.raycast = () => {
    /* pick the solid mesh only */
  }

  const gridMat = new THREE.LineBasicMaterial({
    color: 0x6f9e96,
    transparent: true,
    opacity: 0.52,
    depthTest: true,
    depthWrite: false,
  })
  const faceGrid = new THREE.LineSegments(buildBoxFaceGridGeometry(w, h, d, COLLIDER_BOX_GRID_DIVS), gridMat)
  faceGrid.name = 'colliderFaceGrid'
  faceGrid.renderOrder = 12
  faceGrid.raycast = () => {
    /* pick the solid mesh only */
  }

  /** Pass B: faint rim only where occluded (depth > buffer) — x-ray hint inside splats. */
  const xrayMat = new THREE.LineBasicMaterial({
    color: 0x5eead4,
    transparent: true,
    opacity: colliderDebug.xrayOpacity,
    depthTest: true,
    depthFunc: THREE.GreaterDepth,
    depthWrite: false,
  })
  const xrayEdges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), xrayMat)
  xrayEdges.name = 'colliderXrayEdges'
  xrayEdges.renderOrder = 14
  xrayEdges.visible = colliderDebug.xrayOpacity > 0.001
  xrayEdges.raycast = () => {}

  group.add(solid)
  group.add(edges)
  group.add(faceGrid)
  group.add(xrayEdges)
  return group
}

function createColliderSphere(radius: number): THREE.Group {
  const group = new THREE.Group()
  group.name = 'ColliderSphere'

  const geom = new THREE.SphereGeometry(radius, 16, 12)
  const mat = new THREE.MeshStandardMaterial({
    color: 0x5eead4, transparent: true, opacity: colliderDebug.fillOpacity,
    metalness: 0.1, roughness: 0.65, depthWrite: false,
    alphaHash: colliderDebug.fillAlphaHash,
    polygonOffset: true,
    polygonOffsetFactor: colliderDebug.fillPolyOffset,
    polygonOffsetUnits: colliderDebug.fillPolyOffset,
  })
  const solid = new THREE.Mesh(geom, mat)
  solid.name = 'colliderSolid'
  solid.userData.isCollider = true
  solid.renderOrder = 6

  const rimMat = new THREE.LineBasicMaterial({
    color: 0xe5fffb, transparent: true, opacity: 1, depthTest: true, depthWrite: false,
  })
  const rim = new THREE.LineSegments(buildSphereRingGeometry(radius), rimMat)
  rim.name = 'colliderEdges'
  rim.renderOrder = 12
  rim.raycast = () => {}

  const xrayMat = new THREE.LineBasicMaterial({
    color: 0x5eead4, transparent: true, opacity: colliderDebug.xrayOpacity,
    depthTest: true, depthFunc: THREE.GreaterDepth, depthWrite: false,
  })
  const xrayRim = new THREE.LineSegments(buildSphereRingGeometry(radius), xrayMat)
  xrayRim.name = 'colliderXrayEdges'
  xrayRim.renderOrder = 14
  xrayRim.visible = colliderDebug.xrayOpacity > 0.001
  xrayRim.raycast = () => {}

  group.add(solid, rim, xrayRim)
  return group
}

function createColliderCylinder(radius: number, height: number): THREE.Group {
  const group = new THREE.Group()
  group.name = 'ColliderCylinder'

  const geom = new THREE.CylinderGeometry(radius, radius, height, 20, 1)
  const mat = new THREE.MeshStandardMaterial({
    color: 0x5eead4, transparent: true, opacity: colliderDebug.fillOpacity,
    metalness: 0.1, roughness: 0.65, depthWrite: false,
    alphaHash: colliderDebug.fillAlphaHash,
    polygonOffset: true,
    polygonOffsetFactor: colliderDebug.fillPolyOffset,
    polygonOffsetUnits: colliderDebug.fillPolyOffset,
  })
  const solid = new THREE.Mesh(geom, mat)
  solid.name = 'colliderSolid'
  solid.userData.isCollider = true
  solid.renderOrder = 6

  const rimMat = new THREE.LineBasicMaterial({
    color: 0xe5fffb, transparent: true, opacity: 1, depthTest: true, depthWrite: false,
  })
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), rimMat)
  edges.name = 'colliderEdges'
  edges.renderOrder = 12
  edges.raycast = () => {}

  const xrayMat = new THREE.LineBasicMaterial({
    color: 0x5eead4, transparent: true, opacity: colliderDebug.xrayOpacity,
    depthTest: true, depthFunc: THREE.GreaterDepth, depthWrite: false,
  })
  const xrayEdges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), xrayMat)
  xrayEdges.name = 'colliderXrayEdges'
  xrayEdges.renderOrder = 14
  xrayEdges.visible = colliderDebug.xrayOpacity > 0.001
  xrayEdges.raycast = () => {}

  group.add(solid, edges, xrayEdges)
  return group
}

function copySelectedColliderToClipboard() {
  if (!selected) { setStatus('Nothing to copy.', true); return }
  const solid = selected.getObjectByName('colliderSolid') as THREE.Mesh | undefined
  if (!solid?.geometry) return

  let shapeType: PrimitiveShape = 'box'
  let width = 1, height = 1, depth = 1, radius = 0.5
  if (solid.geometry instanceof THREE.BoxGeometry) {
    shapeType = 'box'
    ;({ width, height, depth } = solid.geometry.parameters)
    radius = Math.min(width, height, depth) * 0.5
  } else if (solid.geometry instanceof THREE.SphereGeometry) {
    shapeType = 'sphere'
    radius = solid.geometry.parameters.radius
    width = depth = radius * 2; height = radius * 2
  } else if (solid.geometry instanceof THREE.CylinderGeometry) {
    shapeType = 'cylinder'
    radius = solid.geometry.parameters.radiusTop
    height = solid.geometry.parameters.height
    width = depth = radius * 2
  } else { return }

  colliderClipboard = {
    shapeType, width, height, depth, radius,
    position: selected.position.clone(),
    quaternion: selected.quaternion.clone(),
    scale: selected.scale.clone(),
  }
  const label = shapeType[0].toUpperCase() + shapeType.slice(1)
  setStatus(`${label} copied.`)
}

function pasteColliderFromClipboard() {
  if (!colliderClipboard) { setStatus('Nothing to paste.', true); return }
  const c = colliderClipboard
  const nudge = Math.max(c.width, c.height, c.depth) * 0.12 + 0.06
  pasteNudgeWorld.set(nudge, 0, 0).applyQuaternion(c.quaternion)

  let g: THREE.Group
  if (c.shapeType === 'sphere') {
    g = createColliderSphere(c.radius)
  } else if (c.shapeType === 'cylinder') {
    g = createColliderCylinder(c.radius, c.height)
  } else {
    g = createColliderBox(c.width, c.height, c.depth)
  }
  g.position.copy(c.position).add(pasteNudgeWorld)
  g.quaternion.copy(c.quaternion)
  g.scale.copy(c.scale)
  registerCollider(g)
  colliderRoot.add(g)
  selectCollider(g)
  const label = c.shapeType[0].toUpperCase() + c.shapeType.slice(1)
  setStatus(`${label} pasted.`)
}

function setSelectedHighlight(group: THREE.Group | null) {
  const baseFill = colliderDebug.fillOpacity
  for (const g of colliderRoot.children) {
    if (!(g instanceof THREE.Group)) continue
    const solid = g.getObjectByName('colliderSolid') as THREE.Mesh | undefined
    const edges = g.getObjectByName('colliderEdges') as THREE.LineSegments | undefined
    const faceGrid = g.getObjectByName('colliderFaceGrid') as THREE.LineSegments | undefined
    const xray = g.getObjectByName('colliderXrayEdges') as THREE.LineSegments | undefined
    if (!solid?.material || !edges?.material) continue
    const sm = solid.material as THREE.MeshStandardMaterial
    const rim = edges.material as THREE.LineBasicMaterial
    const grid = faceGrid?.material as THREE.LineBasicMaterial | undefined
    const xr = xray?.material as THREE.LineBasicMaterial | undefined
    if (g === group) {
      sm.color.setHex(0xfbbf24)
      sm.opacity = 0
      rim.color.setHex(0xfff2c4)
      rim.opacity = Math.min(1, colliderDebug.edgeOpacity + 0.18)
      if (grid) {
        grid.color.setHex(0xc9a86a)
        grid.opacity = 0.38 * Math.min(1, colliderDebug.edgeOpacity + 0.18)
      }
      if (xr) {
        xr.color.setHex(0xffe08a)
        xr.opacity = colliderDebug.xrayOpacity
      }
    } else {
      sm.color.setHex(0x5eead4)
      sm.opacity = baseFill
      rim.color.setHex(0xe5fffb)
      rim.opacity = colliderDebug.edgeOpacity
      if (grid) {
        grid.color.setHex(0x6f9e96)
        grid.opacity = 0.52 * colliderDebug.edgeOpacity
      }
      if (xr) {
        xr.color.setHex(0x5eead4)
        xr.opacity = colliderDebug.xrayOpacity
      }
    }
    if (xray) {
      xray.visible = colliderDebug.xrayOpacity > 0.001
    }
  }
}

function applyColliderDebugFromGui() {
  // Draft material (shared across box/sphere/cylinder previews)
  draftBoxMat.alphaHash = colliderDebug.fillAlphaHash
  draftBoxMat.polygonOffsetFactor = colliderDebug.fillPolyOffset
  draftBoxMat.polygonOffsetUnits = colliderDebug.fillPolyOffset
  draftBoxMat.opacity = Math.min(0.95, colliderDebug.fillOpacity + 0.12)
  draftBoxMat.needsUpdate = true

  // Splat render order
  spark.renderOrder = splatRenderOrder
  spark.sortRadial = splatSortRadialValue
  spark.falloff = splatFalloffValue
  spark.sortDirty = true
  spark.material.transparent = splatTransparentValue
  spark.material.depthTest = splatDepthTestValue
  spark.material.depthWrite = splatDepthWriteValue
  spark.material.needsUpdate = true

  // Committed colliders
  for (const g of colliderRoot.children) {
    if (!(g instanceof THREE.Group)) continue
    const solid   = g.getObjectByName('colliderSolid')     as THREE.Mesh          | undefined
    const edges   = g.getObjectByName('colliderEdges')     as THREE.LineSegments  | undefined
    const faceGrid= g.getObjectByName('colliderFaceGrid')  as THREE.LineSegments  | undefined
    const xray    = g.getObjectByName('colliderXrayEdges') as THREE.LineSegments  | undefined

    if (solid?.material instanceof THREE.MeshStandardMaterial) {
      const sm = solid.material
      sm.alphaHash = colliderDebug.fillAlphaHash
      sm.polygonOffsetFactor = colliderDebug.fillPolyOffset
      sm.polygonOffsetUnits = colliderDebug.fillPolyOffset
      sm.depthWrite = colliderDebug.fillDepthWrite
      sm.needsUpdate = true
      solid.renderOrder = colliderDebug.fillRenderOrder
    }
    if (edges?.material instanceof THREE.LineBasicMaterial) {
      edges.material.depthTest = colliderDebug.edgeDepthTest
      edges.material.needsUpdate = true
      edges.renderOrder = colliderDebug.edgeRenderOrder
    }
    if (faceGrid?.material instanceof THREE.LineBasicMaterial) {
      faceGrid.material.depthTest = colliderDebug.edgeDepthTest
      faceGrid.material.needsUpdate = true
      faceGrid.renderOrder = colliderDebug.edgeRenderOrder
    }
    if (xray?.material instanceof THREE.LineBasicMaterial) {
      xray.material.opacity = colliderDebug.xrayOpacity
      xray.visible = colliderDebug.xrayOpacity > 0.001
      xray.renderOrder = colliderDebug.xrayRenderOrder
      xray.material.needsUpdate = true
    }
  }
  setSelectedHighlight(selected)
}

// ── Hierarchy SVG icons ──────────────────────────────────────────────────────
const ICON_EYE = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 6.5C2.8 4 4.5 2.8 6.5 2.8s3.7 1.2 5 3.7-3 3.7-5 3.7-3.7-1.2-5-3.7z"/><circle cx="6.5" cy="6.5" r="1.6" fill="currentColor" stroke="none"/></svg>`
const ICON_EYE_OFF = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="11" x2="11" y2="2"/><path d="M4.5 9C5.1 9.6 5.8 10 6.5 10c2 0 3.7-1.2 5-3.7-.5-1-1.1-1.7-1.8-2.2" stroke-opacity="0.55"/><path d="M1.5 6.5C2.2 5.1 3 4.1 4 3.6" stroke-opacity="0.55"/></svg>`
const ICON_LOCK = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="5.5" width="8" height="6" rx="1.5"/><path d="M4.5 5.5V4.2a2 2 0 014 0v1.3"/></svg>`
const ICON_LOCK_OPEN = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="5.5" width="8" height="6" rx="1.5"/><path d="M4.5 5.5V4.2a2 2 0 014 0" stroke-opacity="0.3"/></svg>`

function registerCollider(group: THREE.Group, name?: string) {
  boxCounter++
  const autoName = group.name === 'ColliderSphere'   ? `Sphere ${boxCounter}`
                 : group.name === 'ColliderCylinder' ? `Cylinder ${boxCounter}`
                 : `Box ${boxCounter}`
  hierarchyMeta.set(group, { name: name ?? autoName, hidden: false, locked: false })
}

function updateHierarchyGlobalBtns(boxes: THREE.Group[]) {
  const visBtn = document.querySelector<HTMLButtonElement>('#hier-vis-all')
  const lockBtn = document.querySelector<HTMLButtonElement>('#hier-lock-all')
  if (!visBtn || !lockBtn) return
  if (!boxes.length) {
    visBtn.innerHTML = ICON_EYE
    visBtn.title = 'Hide all'
    lockBtn.innerHTML = ICON_LOCK_OPEN
    lockBtn.title = 'Lock all'
    return
  }
  const anyVisible = boxes.some((g) => !hierarchyMeta.get(g)?.hidden)
  const anyUnlocked = boxes.some((g) => !hierarchyMeta.get(g)?.locked)
  visBtn.innerHTML = anyVisible ? ICON_EYE : ICON_EYE_OFF
  visBtn.title = anyVisible ? 'Hide all' : 'Show all'
  lockBtn.innerHTML = anyUnlocked ? ICON_LOCK_OPEN : ICON_LOCK
  lockBtn.title = anyUnlocked ? 'Lock all' : 'Unlock all'
}

function renderHierarchy() {
  const list = document.querySelector<HTMLElement>('#hier-list')
  if (!list) return
  const boxes = colliderRoot.children.filter((c): c is THREE.Group => c instanceof THREE.Group)

  if (boxes.length === 0) {
    list.innerHTML = '<div class="hier-empty">No shapes yet</div>'
    updateHierarchyGlobalBtns(boxes)
    return
  }

  list.innerHTML = ''
  for (const group of boxes) {
    const meta = hierarchyMeta.get(group)
    if (!meta) continue

    const item = document.createElement('div')
    const cls = ['hier-item']
    if (group === selected) cls.push('is-selected')
    if (meta.hidden) cls.push('is-hidden')
    if (meta.locked) cls.push('is-locked')
    item.className = cls.join(' ')

    const nameSpan = document.createElement('span')
    nameSpan.className = 'hier-item-name'
    nameSpan.textContent = meta.name

    const visBtn = document.createElement('button')
    visBtn.type = 'button'
    visBtn.className = 'hier-btn hier-vis-btn'
    visBtn.title = meta.hidden ? 'Show' : 'Hide'
    visBtn.innerHTML = meta.hidden ? ICON_EYE_OFF : ICON_EYE

    const lockBtn = document.createElement('button')
    lockBtn.type = 'button'
    lockBtn.className = 'hier-btn hier-lock-btn'
    lockBtn.title = meta.locked ? 'Unlock' : 'Lock'
    lockBtn.innerHTML = meta.locked ? ICON_LOCK : ICON_LOCK_OPEN

    item.append(nameSpan, visBtn, lockBtn)

    item.addEventListener('mousedown', (e) => e.preventDefault())

    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.hier-btn')) return
      if (!meta.locked && !meta.hidden) selectCollider(group)
    })

    visBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      meta.hidden = !meta.hidden
      group.visible = !meta.hidden
      if (meta.hidden && selected === group) selectCollider(null)
      renderHierarchy()
    })

    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      meta.locked = !meta.locked
      if (meta.locked && selected === group) selectCollider(null)
      renderHierarchy()
    })

    list.appendChild(item)
  }

  updateHierarchyGlobalBtns(boxes)
}

function selectCollider(group: THREE.Group | null) {
  if (selected === group) return
  if (group !== null) {
    const meta = hierarchyMeta.get(group)
    if (meta?.locked || meta?.hidden) return
  }
  selected = group
  setSelectedHighlight(group)
  if (group) {
    transform.attach(group)
    transformSpace = defaultTransformSpaceForCollider(group)
    applyTransformSpace()
  } else {
    transform.detach()
  }
  updateSplatHighlightBounds()
  syncTransformEnabled()
  renderHierarchy()
}


function isIgnoredTransformControlsPick(obj: THREE.Object3D): boolean {
  const o = obj as THREE.Object3D & { isTransformControlsPlane?: boolean; tag?: string }
  if (o.isTransformControlsPlane === true || obj.type === 'TransformControlsPlane') return true
  if (o.tag === 'helper') return true
  return false
}

/**
 * Closest hit wins among real handles vs colliders. Skips TransformControls’ huge drag plane and
 * scaled “helper” lines so clicks on empty space are not misclassified as gizmo hits.
 */
function resolveColliderVsGizmoPick(clientX: number, clientY: number): THREE.Group | 'gizmo' | null {
  pointer.x = (clientX / window.innerWidth) * 2 - 1
  pointer.y = -(clientY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(pointer, camera)

  let gizmoDist = Infinity
  if (transform.object !== undefined) {
    const gh = raycaster.intersectObject(transform.getHelper(), true)
    gh.sort((a, b) => a.distance - b.distance)
    for (const h of gh) {
      if (isIgnoredTransformControlsPick(h.object)) continue
      gizmoDist = h.distance
      break
    }
  }

  let colliderDist = Infinity
  let closestCollider: THREE.Group | null = null
  for (const h of raycaster.intersectObjects(colliderRoot.children, true)) {
    let o: THREE.Object3D | null = h.object
    while (o) {
      if (o instanceof THREE.Group && o.parent === colliderRoot) {
        if (h.distance < colliderDist) {
          colliderDist = h.distance
          closestCollider = o
        }
        break
      }
      o = o.parent
    }
  }

  // Gizmo always wins when hit — prevents other boxes from occluding handles.
  if (gizmoDist < Infinity) return 'gizmo'
  return closestCollider
}

canvas.addEventListener('contextmenu', (ev) => ev.preventDefault())

canvas.addEventListener('pointermove', (ev) => updateCursorForHover(ev.clientX, ev.clientY))

/**
 * Unified capture-phase LMB handler.
 * Priority: height-commit > gizmo > collider select > drag-to-draw.
 */
canvas.addEventListener(
  'pointerdown',
  (ev) => {
    if (ev.button !== 0) return

    // Height phase: any LMB click commits the shape
    if (drawPhase === 'adjusting_height') {
      commitAddFromDraft()
      ev.preventDefault()
      ev.stopImmediatePropagation()
      return
    }

    // Only start new interactions when idle
    if (drawPhase !== 'idle') return

    const pick = resolveColliderVsGizmoPick(ev.clientX, ev.clientY)

    // Let TransformControls handle its own handles
    if (pick === 'gizmo') return

    // Click on existing collider → select
    if (pick instanceof THREE.Group) {
      selectCollider(pick)
      ev.preventDefault()
      ev.stopImmediatePropagation()
      return
    }

    // Empty space: begin drag-to-draw (corner A set here, corner B on pointerup)
    if (rayToGround(ev.clientX, ev.clientY, addCorner0)) {
      dragStart.set(ev.clientX, ev.clientY)
      addCorner1.copy(addCorner0)
      drawPhase = 'dragging_footprint'
      canvas.style.cursor = 'crosshair'
      canvas.addEventListener('pointermove', onFootprintDragMove)
      try { canvas.setPointerCapture(ev.pointerId) } catch { /* ignore */ }
      updateDraftVisual()
      ev.preventDefault()
      ev.stopImmediatePropagation()
    }
  },
  true,
)

/** Finalize footprint on LMB release; small drags are treated as deselect-clicks. */
canvas.addEventListener('pointerup', (ev) => {
  if (ev.button !== 0 || drawPhase !== 'dragging_footprint') return

  canvas.removeEventListener('pointermove', onFootprintDragMove)
  try { canvas.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }

  const dx = ev.clientX - dragStart.x
  const dy = ev.clientY - dragStart.y
  if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD_PX) {
    // Treat as a click: cancel draft and deselect
    clearDraft()
    if (selected) selectCollider(null)
    return
  }

  // Drag was large enough → finalise corner B
  if (!rayToGround(ev.clientX, ev.clientY, addCorner1)) {
    clearDraft()
    setStatus('Miss — aim at the grid.', true)
    return
  }

  if (activeShape === 'box') {
    const raw = cornersToRawRect(addCorner0, addCorner1)
    if (raw.rw < MIN_BOX || raw.rd < MIN_BOX) {
      clearDraft()
      setStatus('Footprint too small.', true)
      return
    }
    addBaseSpec = rawRectToSpec(raw)
    beginHeightAdjust(ev.clientY)
  } else if (activeShape === 'sphere') {
    const spec = cornersToCircleSpec(addCorner0, addCorner1)
    if (spec.radius < MIN_BOX) { clearDraft(); setStatus('Radius too small.', true); return }
    addBaseSpec = spec
    commitAddFromDraft()  // sphere has no height phase
  } else { // cylinder
    const spec = cornersToCircleSpec(addCorner0, addCorner1)
    if (spec.radius < MIN_BOX) { clearDraft(); setStatus('Radius too small.', true); return }
    addBaseSpec = spec
    beginHeightAdjust(ev.clientY)
  }
})

/** RMB drag = free look (same as navigate mode). */
canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button === 2) {
    startNavLook(ev)
    ev.preventDefault()
  }
})

/** True when game shortcuts should yield to real text entry (not color pickers, etc.). */
function isTypingInField(): boolean {
  const el = document.activeElement
  if (!el) return false
  if (el instanceof HTMLElement && el.isContentEditable) return true
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLInputElement) {
    const t = el.type
    if (
      t === 'button' ||
      t === 'checkbox' ||
      t === 'color' ||
      t === 'file' ||
      t === 'hidden' ||
      t === 'radio' ||
      t === 'range' ||
      t === 'reset' ||
      t === 'submit'
    ) {
      return false
    }
    return true
  }
  return false
}

/** Clicking the canvas should return keyboard focus to the scene (inputs were blocking WASD, etc.). */
function blurFieldFocusForCanvas() {
  const a = document.activeElement
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement) {
    a.blur()
  }
}

canvas.addEventListener('pointerdown', blurFieldFocusForCanvas, true)

window.addEventListener('keydown', (ev) => {
  if (isTypingInField()) return
  syncTransformConstraintSnapsFromKeyboard(ev)

  const mod = ev.metaKey || ev.ctrlKey
  if (mod && ev.code === 'KeyC') {
    ev.preventDefault()
    copySelectedColliderToClipboard()
    return
  }
  if (mod && ev.code === 'KeyV' && !ev.repeat) {
    ev.preventDefault()
    pasteColliderFromClipboard()
    return
  }

  if (ev.ctrlKey || ev.metaKey || ev.altKey) return

  if (!ev.repeat && ev.code === 'KeyC') {
    transformSpace = transformSpace === 'world' ? 'local' : 'world'
    applyTransformSpace()
    setStatus(transformSpace === 'world' ? 'Gizmo: world axes' : 'Gizmo: local axes')
    ev.preventDefault()
    return
  }

  if (ev.key === 'Escape') {
    if (drawPhase !== 'idle') {
      clearDraft()
      setStatus('')
      ev.preventDefault()
    } else if (selected) {
      selectCollider(null)
      ev.preventDefault()
    }
    teardownNavLook()
    return
  }

  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    if (selected) {
      hierarchyMeta.delete(selected)
      colliderRoot.remove(selected)
      transform.detach()
      selected = null
      setSelectedHighlight(null)
      syncTransformEnabled()
      renderHierarchy()
    }
    return
  }

  if (!ev.repeat) {
    if (ev.code === 'KeyG') {
      ev.preventDefault()
      setGizmoMode('translate')
      return
    }
    if (ev.code === 'KeyR') {
      ev.preventDefault()
      setGizmoMode('rotate')
      return
    }
    if (ev.code === 'KeyF') {
      ev.preventDefault()
      setGizmoMode('scale', { fromScaleHotkey: true })
      return
    }
    if (transform.mode === 'scale') {
      const k = ev.key.toLowerCase()
      if (k === 'x' || k === 'y' || k === 'z') {
        ev.preventDefault()
        setGizmoMode('scale', { scaleLock: k as 'x' | 'y' | 'z' })
        return
      }
    }
  }

  // WASD fly
  switch (ev.code) {
    case 'KeyW':
      navMove.forward = 1
      ev.preventDefault()
      return
    case 'KeyS':
      navMove.back = 1
      ev.preventDefault()
      return
    case 'KeyA':
      navMove.left = 1
      ev.preventDefault()
      return
    case 'KeyD':
      navMove.right = 1
      ev.preventDefault()
      return
    default:
      break
  }
})

window.addEventListener('keyup', (ev) => {
  if (isTypingInField()) return
  syncTransformConstraintSnapsFromKeyboard(ev)
  switch (ev.code) {
    case 'KeyW':
      navMove.forward = 0
      break
    case 'KeyS':
      navMove.back = 0
      break
    case 'KeyA':
      navMove.left = 0
      break
    case 'KeyD':
      navMove.right = 0
      break
    default:
      return
  }
  ev.preventDefault()
})

exportBtn.addEventListener('click', () => {
  if (colliderRoot.children.length === 0) {
    setStatus('Nothing to export.', true)
    return
  }

  const exportRoot = new THREE.Group()
  exportRoot.name = 'ColliderExport'

  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const mat = new THREE.Matrix4()

  for (const child of colliderRoot.children) {
    if (!(child instanceof THREE.Group)) continue
    const solid = child.getObjectByName('colliderSolid') as THREE.Mesh | undefined
    if (!solid || !solid.geometry) continue

    child.updateMatrixWorld(true)
    mat.copy(solid.matrixWorld)
    mat.decompose(pos, quat, scale)

    const mesh = new THREE.Mesh(solid.geometry.clone(), new THREE.MeshStandardMaterial({
      color: 0x808080,
      metalness: 0.05,
      roughness: 0.9,
    }))
    mesh.name = `box_${exportRoot.children.length}`
    mesh.position.copy(pos)
    mesh.quaternion.copy(quat)
    mesh.scale.copy(scale)
    exportRoot.add(mesh)
  }

  const exporter = new GLTFExporter()
  exporter.parse(
    exportRoot,
    (gltf) => {
      const blob = new Blob([gltf as ArrayBuffer], { type: 'model/gltf-binary' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'colliders.glb'
      a.click()
      URL.revokeObjectURL(url)
      setStatus('')
      for (const m of exportRoot.children) {
        const mesh = m as THREE.Mesh
        mesh.geometry.dispose()
        ;(mesh.material as THREE.Material).dispose()
      }
    },
    (err) => setStatus(String(err), true),
    { binary: true },
  )
})

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

canvas.addEventListener(
  'wheel',
  (ev) => {
    if (isTypingInField()) return
    ev.preventDefault()
    const fwd = new THREE.Vector3()
    camera.getWorldDirection(fwd)
    const amount = THREE.MathUtils.clamp(ev.deltaY * 0.0035, -2.5, 2.5)
    camera.position.addScaledVector(fwd, -amount)
  },
  { passive: false },
)

const animClock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = Math.min(animClock.getDelta(), 0.1)
  updateNavFlyMove(dt)
  // Keep dyno worldModifier reactive (re-evaluates when splatOpacityMult.value changes)
  if (currentSplat) currentSplat.needsUpdate = true
  renderer.render(scene, camera)
})

// ── Help / shortcuts toggle ──────────────────────────────────────────────────
document.querySelector('#help-btn')?.addEventListener('click', () => {
  const panel = document.querySelector('#shortcuts-panel')
  const btn = document.querySelector<HTMLButtonElement>('#help-btn')
  if (!panel || !btn) return
  const willShow = panel.hasAttribute('hidden')
  panel.toggleAttribute('hidden')
  btn.classList.toggle('active', willShow)
})

// ── Hierarchy global actions ─────────────────────────────────────────────────
document.querySelector('#hierarchy')?.addEventListener('mousedown', (e) => e.preventDefault())

document.querySelector('#hier-vis-all')?.addEventListener('click', () => {
  const boxes = colliderRoot.children.filter((c): c is THREE.Group => c instanceof THREE.Group)
  const anyVisible = boxes.some((g) => !hierarchyMeta.get(g)?.hidden)
  for (const g of boxes) {
    const meta = hierarchyMeta.get(g)
    if (!meta) continue
    meta.hidden = anyVisible
    g.visible = !meta.hidden
  }
  if (selected && hierarchyMeta.get(selected)?.hidden) selectCollider(null)
  renderHierarchy()
})

document.querySelector('#hier-lock-all')?.addEventListener('click', () => {
  const boxes = colliderRoot.children.filter((c): c is THREE.Group => c instanceof THREE.Group)
  const anyUnlocked = boxes.some((g) => !hierarchyMeta.get(g)?.locked)
  for (const g of boxes) {
    const meta = hierarchyMeta.get(g)
    if (!meta) continue
    meta.locked = anyUnlocked
  }
  if (selected && hierarchyMeta.get(selected)?.locked) selectCollider(null)
  renderHierarchy()
})

// ── Shape selector ───────────────────────────────────────────────────────────
document.querySelector('#shape-type')?.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button')
  if (!btn?.dataset.shape) return
  const shape = btn.dataset.shape as PrimitiveShape
  activeShape = shape
  document.querySelectorAll<HTMLButtonElement>('#shape-type button').forEach((b) => {
    b.classList.toggle('active', b.dataset.shape === shape)
  })
  if (drawPhase !== 'idle') clearDraft()
})

const flySpeedEl = document.querySelector<HTMLInputElement>('#gui-fly-speed')
if (flySpeedEl) {
  flySpeedEl.value = String(NAV_FLY_SPEED)
  flySpeedEl.addEventListener('input', () => {
    NAV_FLY_SPEED = THREE.MathUtils.clamp(parseFloat(flySpeedEl.value) || NAV_FLY_SPEED, 0.5, 40)
    flySpeedEl.value = String(NAV_FLY_SPEED)
  })
}

// ── Depth & Render GUI (floating panel) ──────────────────────────────────────
function initDepthGui() {
  const splatOpEl    = document.querySelector<HTMLInputElement>('#gui-splat-opacity')
  const splatBrightEl= document.querySelector<HTMLInputElement>('#gui-splat-brightness')
  const splatTintEl  = document.querySelector<HTMLInputElement>('#gui-splat-tint')
  const splatTintColEl = document.querySelector<HTMLInputElement>('#gui-splat-tint-color')
  const splatRoEl    = document.querySelector<HTMLInputElement>('#gui-splat-ro')
  const splatTransparentEl = document.querySelector<HTMLInputElement>('#gui-splat-transparent')
  const splatDepthTestEl = document.querySelector<HTMLInputElement>('#gui-splat-depth-test')
  const splatDepthWriteEl = document.querySelector<HTMLInputElement>('#gui-splat-depth-write')
  const splatSortRadialEl = document.querySelector<HTMLInputElement>('#gui-splat-sort-radial')
  const splatFalloffEl = document.querySelector<HTMLInputElement>('#gui-splat-falloff')
  const splatHiEl    = document.querySelector<HTMLInputElement>('#gui-splat-highlight')
  const splatHiAmtEl = document.querySelector<HTMLInputElement>('#gui-splat-highlight-amount')
  const splatHiColEl = document.querySelector<HTMLInputElement>('#gui-splat-highlight-color')
  const fillOpEl     = document.querySelector<HTMLInputElement>('#gui-render-fill-opacity')
  const fillRoEl     = document.querySelector<HTMLInputElement>('#gui-fill-ro')
  const fillDwEl     = document.querySelector<HTMLInputElement>('#gui-fill-dw')
  const edgeOpEl     = document.querySelector<HTMLInputElement>('#gui-edge-opacity')
  const edgeRoEl     = document.querySelector<HTMLInputElement>('#gui-edge-ro')
  const edgeDtEl     = document.querySelector<HTMLInputElement>('#gui-edge-dt')
  const xrayOpEl     = document.querySelector<HTMLInputElement>('#gui-xray-opacity')
  const xrayRoEl     = document.querySelector<HTMLInputElement>('#gui-xray-ro')

  const apply = () => {
    // Splat
    splatOpacityValue            = THREE.MathUtils.clamp(parseFloat(splatOpEl?.value ?? '1'), 0, 1)
    splatOpacityMult.value       = splatOpacityValue
    splatBrightnessValue         = THREE.MathUtils.clamp(parseFloat(splatBrightEl?.value ?? '1'), 0, 2)
    splatBrightnessMult.value    = splatBrightnessValue
    splatTintAmountValue         = THREE.MathUtils.clamp(parseFloat(splatTintEl?.value ?? '0'), 0, 1)
    splatTintAmount.value        = splatTintAmountValue
    if (splatTintColEl) {
      const c = new THREE.Color(hexFromColorInput(splatTintColEl))
      splatTintColor.value.set(c.r, c.g, c.b)
    }
    splatRenderOrder             = parseInt(splatRoEl?.value ?? '1', 10)
    splatTransparentValue        = splatTransparentEl?.checked ?? true
    splatDepthTestValue          = splatDepthTestEl?.checked ?? true
    splatDepthWriteValue         = splatDepthWriteEl?.checked ?? true
    splatSortRadialValue         = splatSortRadialEl?.checked ?? false
    splatFalloffValue            = THREE.MathUtils.clamp(parseFloat(splatFalloffEl?.value ?? '1'), 0, 1)
    splatHighlightEnabledValue   = splatHiEl?.checked ?? true
    splatHighlightEnabled.value  = splatHighlightEnabledValue
    splatHighlightAmountValue    = THREE.MathUtils.clamp(parseFloat(splatHiAmtEl?.value ?? '0.7'), 0, 1)
    splatHighlightAmount.value   = splatHighlightAmountValue
    if (splatHiColEl) {
      const c = new THREE.Color(hexFromColorInput(splatHiColEl))
      splatHighlightColor.value.set(c.r, c.g, c.b)
    }
    updateSplatHighlightBounds()
    // Fill
    colliderDebug.fillOpacity = THREE.MathUtils.clamp(parseFloat(fillOpEl?.value ?? '0.25'), 0, 0.85)
    colliderDebug.fillRenderOrder = parseInt(fillRoEl?.value ?? '3', 10)
    colliderDebug.fillDepthWrite  = fillDwEl?.checked ?? false
    // Edges
    colliderDebug.edgeOpacity     = THREE.MathUtils.clamp(parseFloat(edgeOpEl?.value ?? '1'), 0, 1)
    colliderDebug.edgeRenderOrder = parseInt(edgeRoEl?.value ?? '4', 10)
    colliderDebug.edgeDepthTest   = edgeDtEl?.checked ?? true
    // X-ray
    colliderDebug.xrayOpacity     = THREE.MathUtils.clamp(parseFloat(xrayOpEl?.value ?? '0.3'), 0, 0.8)
    colliderDebug.xrayRenderOrder = parseInt(xrayRoEl?.value ?? '2', 10)
    applyColliderDebugFromGui()
  }

  const inputs = [
    splatOpEl, splatBrightEl, splatTintEl, splatTintColEl, splatRoEl,
    splatTransparentEl, splatDepthTestEl, splatDepthWriteEl, splatSortRadialEl, splatFalloffEl,
    splatHiEl, splatHiAmtEl, splatHiColEl,
    fillOpEl, fillRoEl, fillDwEl, edgeOpEl, edgeRoEl, edgeDtEl, xrayOpEl, xrayRoEl,
  ]
  for (const el of inputs) {
    if (!el) continue
    el.addEventListener('input', apply)
    el.addEventListener('change', apply)
  }

  // Floating panel toggle
  const toggleBtn = document.querySelector<HTMLButtonElement>('#depth-panel-toggle')
  const panelBody = document.querySelector<HTMLElement>('#depth-panel-body')
  toggleBtn?.addEventListener('click', () => {
    const isHidden = panelBody?.hasAttribute('hidden')
    panelBody?.toggleAttribute('hidden', !isHidden)
    toggleBtn.classList.toggle('active', !!isHidden)
  })
}
initDepthGui()

applyColliderDebugFromGui()
renderHierarchy()
