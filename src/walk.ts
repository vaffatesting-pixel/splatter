// Third-person walk test: Gaussian splat for looks, exported .glb colliders for physics.
// Standalone page (walk.html) — does not touch the collider builder in main.ts.
import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { dyno, type GsplatModifier, SparkRenderer, SplatMesh, SplatFileType } from '@sparkjsdev/spark'
import { GameAudio, AUDIO_PARAMS, type AudioState } from './audio'
import { IS_TOUCH, setupTouch, setupOrientationHint } from './mobile'
import { Net, type Move } from './net'
import { Peers } from './peers'
import { Places, Pointer, type Spot } from './places'
import { Director, DIRECTOR } from './director'

const q = new URLSearchParams(location.search)

/** Ready-made maps: splat + its generated heightfield + a spawn on solid ground. */
const MAPS = [
  // spawns sit in the middle of each map's largest connected flat area
  // decimated to 2M splats (tools/decimate_ply.py): same geometry, 2x the frame rate
  // area/walkable/slope come from the heightfield measurements; difficulty is
  // derived from them, not hand-assigned
  // `light` is the phone build: pruned by importance and rewritten as .splat
  // (32 bytes/gaussian instead of 236). See tools/mklight.py.
  { id: 'capitoline', label: 'Cortile Capitolino', sub: 'Roma', splat: '/cap-2m.ply', light: '/cap-light.splat', hf: '/hf-cap2m.json', spawn: [0.96, 1.89, 0.22], props: true, area: 491, walkable: 80.4, slope: 5.8 },
  // the attic is already 7 MB and 442k gaussians: the phone gets the same file
  { id: 'attic', label: 'Attico', sub: 'Interno', splat: '/attic.spz', light: '/attic.spz', hf: '/hf-attic.json', spawn: [1.97, 0.96, -3.93], props: true, area: 96, walkable: 76.9, slope: 7.7 },
  { id: 'bonsai', label: 'Bonsai', sub: 'Studio', splat: '/bonsai.splat', light: '/bonsai-light.splat', hf: '/hf-bonsai.json', spawn: [-3.53, -5.14, -4.51], props: true, area: 751, walkable: 40.3, slope: 9.5 },
  // Tanks & Temples: il rilevamento dell'orientamento si ferma a 1.93x (soglia 2x),
  // quindi la heightfield e' generata forzando ?up=y- — la convenzione COLMAP.
  // Senza raddrizzarla il personaggio nasce dentro la geometria.
  { id: 'truck', label: 'Camion', sub: 'Esterno', splat: '/truck-1m.ply', light: '/truck-light.splat', hf: '/hf-truck.json', spawn: [-0.39, 0.78, 1.37], props: true, area: 5738, walkable: 25.5, slope: 34.4 },
  // Tanks & Temples, stessa correzione d'orientamento del camion
  { id: 'train', label: 'Binari', sub: 'Esterno', splat: '/train-light.splat', light: '/train-light.splat', hf: '/hf-train.json', spawn: [1.78, 1.29, -0.3], props: true, area: 7171, walkable: 10.4, slope: 9.4 },
  // Mip-NeRF360: il raggio libero piu' ampio di tutte le mappe, 6.71
  { id: 'garden', label: 'Giardino', sub: 'Esterno', splat: '/garden-light.splat', light: '/garden-light.splat', hf: '/hf-garden.json', spawn: [0.07, 0.27, 1.27], props: true, area: 2505, walkable: 24.7, slope: 9.9 },
  // playroom's walkable area is narrower than the character, so no props there
  { id: 'playroom', label: 'Playroom', sub: 'Interno', splat: '/playroom.splat', light: '/playroom.splat', hf: '/hf-playroom.json', spawn: [4.12, -0.99, -0.99], props: false, area: 119, walkable: 48.7, slope: 23.0 },
]
/** Difficulty from the metrics: open and flat is easy, broken and steep is not. */
export function difficultyOf(m: { walkable: number; slope: number }) {
  const score = m.walkable - m.slope * 2
  return score > 65 ? 'FACILE' : score > 45 ? 'MEDIA' : score > 15 ? 'DIFFICILE' : 'ESTREMA'
}
const MAP = MAPS.find(m => m.id === q.get('map')) ?? MAPS[0]
// explicit splat/heightfield params win, so the test scripts keep working
const explicit = q.has('splat')

// On a phone the binding constraint is not the frame rate, it is the download
// and the peak memory while the file is parsed. A touch device gets the light
// build unless ?quality says otherwise.
//
// Production is always "low": the full .ply files run from 225 MB to 1.1 GB,
// every one of them past Vercel's 100 MB per-file ceiling, so only the light
// .splat builds are ever deployed. Asking for ?quality=high online would fetch
// a file that is not there — which is what the fallback below is for.
const QUALITY = q.get('quality') ?? (import.meta.env.PROD || IS_TOUCH ? 'low' : 'high')
let splatUrl = q.get('splat') ?? (QUALITY === 'low' ? MAP.light : MAP.splat)
const COLLIDER_URL = q.get('colliders') ?? '/colliders.glb'
const HEIGHTFIELD_URL = q.get('heightfield') ?? (explicit ? null : MAP.hf)
/** Spark picks its parser from the extension, so this follows the url. */
const fileTypeOf = (url: string) => {
  switch (url.split('.').pop()?.toLowerCase()) {
    case 'ply': return SplatFileType.PLY
    case 'rad': return SplatFileType.RAD
    case 'splat': return SplatFileType.SPLAT
    case 'ksplat': return SplatFileType.KSPLAT
    default: return SplatFileType.SPZ
  }
}

const CAPSULE_RADIUS = 0.3
const CAPSULE_HALF = 0.55          // half height of the cylinder part (total ≈ 1.7m)
const WALK_SPEED = 2.6
const RUN_SPEED = 5.0
const GRAVITY = -9.81
const SPAWN = new THREE.Vector3(                     // dropped from above
  Number(q.get('sx') ?? MAP.spawn[0]),
  Number(q.get('sy') ?? MAP.spawn[1]),
  Number(q.get('sz') ?? MAP.spawn[2]),
)

// UI elements (see walk.html)
const titleEl = document.getElementById('title')
const placeNameEl = document.getElementById('placeName')
const placeSubEl = document.getElementById('placeSub')
const loadingEl = document.getElementById('loading')
const loadFillEl = document.getElementById('loadFill')
const loadPctEl = document.getElementById('loadPct')
const loadMapEl = document.getElementById('loadMap')
const loadNoteEl = document.getElementById('loadNote')
const objCountEl = document.getElementById('objCount')
const timeLeftEl = document.getElementById('timeLeft')
const battFillEl = document.getElementById('battFill')
const overEl = document.getElementById('over')
if (loadMapEl) loadMapEl.textContent = MAP.label
if (placeNameEl) placeNameEl.textContent = MAP.label
if (placeSubEl) placeSubEl.textContent = MAP.sub ?? ''

// Some local security suites wrap window.fetch and fail on very large bodies;
// XHR is left alone, so use it for the splat download.
function loadBytes(url: string, onProgress?: (frac: number, loaded: number) => void): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url, true)
    xhr.responseType = 'arraybuffer'
    // XHR reports progress; fetch() would need a stream reader for the same thing
    xhr.onprogress = e => onProgress?.(e.lengthComputable ? e.loaded / e.total : 0, e.loaded)
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve(xhr.response)
      : reject(new Error(`${url} → HTTP ${xhr.status}`)))
    xhr.onerror = () => reject(new Error(`${url} → network error`))
    xhr.send()
  })
}

function setLoad(frac: number, note?: string) {
  if (loadFillEl) loadFillEl.style.width = `${Math.round(frac * 100)}%`
  if (loadPctEl) loadPctEl.textContent = `${Math.round(frac * 100)}%`
  if (note && loadNoteEl) loadNoteEl.textContent = note
}

const stateEl = document.getElementById('state') as HTMLElement
const errEl = document.getElementById('err') as HTMLElement
const fail = (msg: string) => { errEl.textContent = msg; console.error(msg) }

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.setClearColor(q.get('dark') !== '0' ? 0x000000 : 0x383838, 1)
renderer.outputColorSpace = THREE.SRGBColorSpace
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()

// Spark needs its own renderer node in the scene — a SplatMesh alone draws nothing
const spark = new SparkRenderer({ renderer, transparent: true, depthTest: true, depthWrite: true })
spark.sortRadial = false
scene.add(spark)
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 2000)
// three.js fov is VERTICAL, so a portrait phone (aspect ~0.46) would leave only
// ~30° of horizontal view — a telescope. Below aspect 1 we widen the vertical
// fov instead, holding the horizontal view at HFOV so the room stays readable.
const HFOV = THREE.MathUtils.degToRad(75)
function fitCamera() {
  const aspect = innerWidth / innerHeight
  camera.aspect = aspect
  camera.fov = aspect >= 1
    ? 60
    : Math.min(100, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(HFOV / 2) / aspect)))
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
}
addEventListener('resize', fitCamera)
addEventListener('orientationchange', () => setTimeout(fitCamera, 250))
fitCamera()

// ── torch (horror mode) ──────────────────────────────────────────────────────
// Splats are unlit and ignore three.js lights, but Spark lets us rewrite every
// gaussian in a shader graph: splitGsplat gives us its world-space center and
// colour, and we scale that colour by a spot-cone term. Not real lighting —
// just "dark beyond N metres, lit inside a cone" — which is all horror needs.
// ESPLORA e' la modalita' principale: luce piena, nessun timer, si sta insieme.
// GIOCA e' l'horror. La scelta arriva prima che lo splat parta, cosi' non si
// scaricano 12 MB per poi scoprire di aver sbagliato porta.
const MODE = q.get('mode') ?? (q.has('dark') || q.has('splat') ? 'game' : null)
const EXPLORE = MODE === 'explore'
const DARK = q.get('dark') !== '0' && !EXPLORE
if (EXPLORE) document.body.classList.add('explore')
// The lights-out intro: you arrive able to see the place, read where you are,
// then the light drains away and only the torch is left.
const INTRO_HOLD = Number(q.get('introHold') ?? 4.5)   // seconds fully lit
const INTRO_FADE = Number(q.get('introFade') ?? 3.0)   // seconds to go dark
let introT = 0
const torchPos = dyno.dynoVec3(new THREE.Vector3())
const torchDir = dyno.dynoVec3(new THREE.Vector3(0, 0, -1))
const TORCH_RANGE = Number(q.get('range') ?? 7)
const torchRange = dyno.dynoFloat(TORCH_RANGE)
const torchInner = dyno.dynoFloat(0.965)   // cos of the full-bright cone angle
const torchOuter = dyno.dynoFloat(0.87)    // cos of the outer, faded edge
// Ambient floor: pitch black is not scary, it just stops you playing. At 0.08
// distant shapes stay readable as silhouettes without giving the room away.
const AMBIENT_FLOOR = Number(q.get('ambient') ?? 0.08)
const torchAmbient = dyno.dynoFloat(1)     // starts fully lit, see the intro fade
const ONE = dyno.dynoFloat(1)
const ZERO = dyno.dynoFloat(0)

// ── distance culling ─────────────────────────────────────────────────────────
// The torch only reaches TORCH_RANGE, but every gaussian in the file was still
// being sorted, rasterised and blended just to come out black. Killing the
// OPACITY alone would only save the fragments: Spark's sort metric returns
// INFINITY for splats whose ACTIVE flag is clear, and the count of finite
// metrics is exactly the instanceCount of the draw call. So we clear the flag
// too — that removes them from the sort and from the draw.
// CULL_FADE is the soft band before the cut, so nothing pops in as you walk.
const CULL_RANGE = Number(q.get('cull') ?? 15)     // 0 (or dark=0) disables it
const CULL_FADE = Number(q.get('cullFade') ?? 4)   // width of the fade-out band
const NO_CULL = 1e5
const cullOn = CULL_RANGE > 0 && DARK
const cullNear = dyno.dynoFloat(cullOn ? CULL_RANGE : NO_CULL)
const cullFar = dyno.dynoFloat(cullOn ? CULL_RANGE + CULL_FADE : NO_CULL + 1)
// Off-screen culling. Spark already drops what is behind the camera, but a
// gaussian 80° off-axis is still "in front": it gets sorted, instanced and only
// then clipped. We cut everything outside a cone that circumscribes the frustum,
// which by construction removes nothing you could have seen. The margin matters:
// the sort runs asynchronously, so while you turn the culling set lags a few
// frames behind the camera — too tight a cone and the edges pop.
// Splats very close to the eye are kept regardless: at 0.5 u a splat whose
// centre is off-axis can still cover half the screen.
// always on, dark or lit: it never removes anything that could be seen
const FCULL = q.get('fcull') !== '0'
const FCULL_MARGIN = THREE.MathUtils.degToRad(Number(q.get('fcullMargin') ?? 15))
const cullCos = dyno.dynoFloat(-1)      // -1 keeps everything until the loop sets it
const CULL_NEAR_KEEP = 2.0
const cullNearKeep = dyno.dynoFloat(FCULL ? CULL_NEAR_KEEP : 1e9)
const FLAGS_OFF = dyno.dynoUint(0)
// retunable at runtime (window.__setCull) so a range can be compared without
// reloading a 1 GB ply
let cullBase = CULL_RANGE
let fcullOn = FCULL
;(window as unknown as Record<string, unknown>).__setCull = (n: number) => {
  if (!cullOn) return false
  cullBase = n
  cullNear.value = n
  cullFar.value = n + CULL_FADE
  return true
}
;(window as unknown as Record<string, unknown>).__setFcull = (on: boolean) => {
  fcullOn = on && FCULL
  if (!fcullOn) cullCos.value = -1
  return fcullOn
}

function makeTorchModifier(): GsplatModifier {
  return dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {
      const { center, rgb, opacity, flags } = dyno.splitGsplat(gsplat!).outputs
      const toSplat = dyno.sub(center, torchPos)
      const dist = dyno.length(toSplat)
      const cosAngle = dyno.dot(dyno.normalize(toSplat), torchDir)
      // angular falloff: 1 inside the inner cone, fading to 0 at the outer one
      const cone = dyno.smoothstep(torchOuter, torchInner, cosAngle)
      // distance falloff: quadratic, reaching 0 at torchRange
      const t = dyno.clamp(dyno.div(dist, torchRange), ZERO, ONE)
      const falloff = dyno.sub(ONE, dyno.mul(t, t))
      const lit = dyno.max(dyno.mul(cone, falloff), torchAmbient)
      // fade the alpha out across the band, then drop the splat entirely
      const faded = dyno.sub(ONE, dyno.smoothstep(cullNear, cullFar, dist))
      // off-screen: hard cut, no fade — a fade here would be a visible gradient
      // running down the edge of the screen
      const onScreen = dyno.or(
        dyno.lessThan(dist, cullNearKeep),
        dyno.greaterThan(cosAngle, cullCos),
      )
      const gone = dyno.or(dyno.greaterThan(dist, cullFar), dyno.not(onScreen))
      return {
        gsplat: dyno.combineGsplat({
          gsplat,
          rgb: dyno.mul(rgb, lit),
          opacity: dyno.mul(opacity, faded),
          flags: dyno.select(gone, FLAGS_OFF, flags),
        }),
      }
    },
  )
}

// the splat is unlit, but the character uses PBR materials and needs light
const HEMI_LIT = 2.2, HEMI_DARK = 0.12, SUN_LIT = 1.6, SUN_DARK = 0.05
const hemi = new THREE.HemisphereLight(0xcfd4dc, 0x33333a, HEMI_LIT)
scene.add(hemi)
const sun = new THREE.DirectionalLight(0xffffff, SUN_LIT)
sun.position.set(3, 8, 4)
scene.add(sun)

// in the dark the character and props are lit by a real spotlight that rides
// the camera, so mesh and splat agree on where the torch is pointing
const torch = new THREE.SpotLight(0xfff0d0, DARK ? 40 : 0, 0, 0.34, 0.5, 1.4)
const torchTarget = new THREE.Object3D()
if (DARK) {
  scene.add(torch)
  scene.add(torchTarget)
  torch.target = torchTarget
}

// ── audio ────────────────────────────────────────────────────────────────────
// AudioContext needs a user gesture, so it starts on the first click or keypress.
const audio = new GameAudio()
let torchOn = true
const audioState: AudioState = { battery: 1, torchOn: true, timeFraction: 1, allCollected: false }
let audioStarted = false
const startAudio = () => {
  if (audioStarted) return
  audioStarted = true
  audio.init().catch(e => console.warn('audio non inizializzato:', e))
}
addEventListener('pointerdown', startAudio, { once: false })
addEventListener('keydown', startAudio, { once: false })
addEventListener('keydown', e => {
  if (e.repeat || GAME.over) return
  if (e.code === 'KeyF') {
    if (!torchOn && GAME.battery <= 0) return    // nothing left to switch on
    torchOn = !torchOn
    audioState.torchOn = torchOn
    audio.torchClick(torchOn)
  } else if (e.code === 'KeyR') {
    if (GAME.spares <= 0 || GAME.battery > 0.98) return
    GAME.spares--
    GAME.battery = 1
    torchOn = true
    audioState.torchOn = true
    audio.torchClick(true)
    updateHud()
  }
})
// ── presenza ─────────────────────────────────────────────────────────────────
// Vale in ogni modalita': ESPLORA e' quella principale, ma anche al buio si sta
// in compagnia. Si attiva solo con ?room=, così una partita da soli resta
// esattamente com'era, senza connessioni di rete.
const ROOM = q.get('room')
const MY_NAME = (q.get('name') ?? localStorage.getItem('splatter_nome')
  ?? `Ospite ${Math.floor(1000 + Math.random() * 9000)}`).slice(0, 16)
localStorage.setItem('splatter_nome', MY_NAME)

const net = ROOM
  ? new Net({
    room: ROOM, map: MAP.id, name: MY_NAME,
    audioCtx: () => audio.ctx,
    onJoin: () => updatePresence(),
    onLeave: () => updatePresence(),
  })
  : null
let peers: Peers | null = null

const presenceEl = document.getElementById('presence')
const micBtn = document.getElementById('micBtn')
const micAskEl = document.getElementById('micAsk')

function updatePresence() {
  if (!net || !presenceEl) return
  const n = net.peers.size
  presenceEl.textContent = n === 0 ? 'sei solo qui' : `${n + 1} persone`
  presenceEl.classList.toggle('alone', n === 0)
}

function updateMicUi() {
  if (!net || !micBtn) return
  const off = net.muted || !net.micReady
  micBtn.textContent = off ? '🔇' : '🎙'
  micBtn.classList.toggle('off', off)
  micBtn.classList.toggle('live', !off && net.selfSpeaking)
}

if (net) {
  document.body.classList.add('multi')
  updatePresence()
  // Il permesso microfono non si chiede di sorpresa: prima si spiega. La
  // richiesta parte da un tocco, che su iOS e' comunque obbligatorio.
  const ask = (yes: boolean) => async () => {
    micAskEl?.classList.remove('on')
    if (!yes) return
    startAudio()
    const ok = await net.enableMic()
    if (!ok) fail('microfono negato: puoi ascoltare ma non parlare')
    updateMicUi()
  }
  document.getElementById('micYes')?.addEventListener('click', ask(true))
  document.getElementById('micNo')?.addEventListener('click', ask(false))
  micBtn?.addEventListener('click', async () => {
    if (!net.micReady) { micAskEl?.classList.add('on'); return }
    net.setMuted(!net.muted)
    updateMicUi()
  })
  addEventListener('keydown', e => {
    if (e.code !== 'KeyM' || e.repeat) return
    if (!net.micReady) { micAskEl?.classList.add('on'); return }
    net.setMuted(!net.muted)
    updateMicUi()
  })
  net.onPointer = v => pointer.show(v.x, v.y, v.z)
  addEventListener('beforeunload', () => net.leave())
}

// ── luoghi, puntatore, direttore ─────────────────────────────────────────────
const places = new Places(scene, MAP.id)
const pointer = new Pointer(scene)
const director = new Director()
const EDIT = q.get('edit') === '1'
let sitting: Spot | null = null
// "hush" = il silenzio improvviso, l'evento piu' efficace di tutti: tolgo
// l'ambiente per due secondi e mezzo. "flicker" fa tremare la torcia.
let hushUntil = 0
let flickerUntil = 0
;(window as unknown as Record<string, unknown>).__director = () => ({
  tensione: +director.tension.toFixed(1), secondi: +director.elapsed.toFixed(0),
  calma: director.inCalm, eventi: director.log, parametri: DIRECTOR,
})
void places.load()
if (net) net.inSameZone = id => {
  const p = net.peers.get(id)
  return !!p && places.sameZone(charPos.x, charPos.z, p.to.x, p.to.z)
}
const charPos = { x: SPAWN.x, y: SPAWN.y, z: SPAWN.z }

/** Un tono breve messo in un punto del mondo. Serve sia agli obiettivi che
 *  alla minaccia: cambia solo la frequenza e quanto dura. */
function spatialTone(x: number, y: number, z: number, freq: number, dur: number, vol: number, type: OscillatorType = 'sine') {
  const ctx = audio.ctx
  if (!ctx) return
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  const pan = ctx.createPanner()
  pan.panningModel = 'HRTF'
  pan.distanceModel = 'linear'
  pan.rolloffFactor = 0
  if (pan.positionX) { pan.positionX.value = x; pan.positionY.value = y; pan.positionZ.value = z }
  else pan.setPosition(x, y, z)
  o.type = type
  o.frequency.value = freq
  const t = ctx.currentTime
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(vol, t + Math.min(0.08, dur * 0.3))
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(pan).connect(ctx.destination)
  o.start(t)
  o.stop(t + dur + 0.05)
}

/** @returns true se il tasto E e' stato consumato dalla seduta */
function toggleSit(): boolean {
  if (sitting) { sitting = null; return true }
  const seat = places.nearest('seat', charPos.x, charPos.z, 1.4)
  if (!seat) return false
  sitting = seat
  return true
}

// editor: si cammina dove si vuole il punto e si preme un tasto
if (EDIT) {
  addEventListener('keydown', e => {
    if (e.repeat) return
    const at = { x: charPos.x, y: charPos.y, z: charPos.z }
    const mk = (t: Spot['t'], extra: Partial<Spot> = {}) => {
      places.add({ t, ...at, ...extra })
      hintEl.textContent = `${t} piazzato · ${places.spots.length} punti`
    }
    if (e.code === 'Digit1') mk('seat')
    else if (e.code === 'Digit2') mk('zone', { r: 3 })
    else if (e.code === 'Digit3') mk('poi', { title: prompt('Titolo?') ?? 'Punto', desc: prompt('Descrizione?') ?? '', link: prompt('Link?') ?? '' })
    else if (e.code === 'Digit4') mk('portal', { title: prompt('Titolo?') ?? 'Portale', map: prompt('Mappa di destinazione?') ?? 'attic' })
    else if (e.code === 'Backspace') { places.removeLast(); hintEl.textContent = `rimosso · ${places.spots.length} punti` }
    else if (e.code === 'KeyP') places.download()
  })
}

;(window as unknown as Record<string, unknown>).__net = net
;(window as unknown as Record<string, unknown>).__peers = () => net
  ? [...net.peers.values()].map(p => ({
    id: p.id.slice(0, 6), name: p.name, x: +p.to.x.toFixed(2), y: +p.to.y.toFixed(2),
    z: +p.to.z.toFixed(2), w: p.to.w, level: +p.level.toFixed(3),
    speaking: net.isSpeaking(p), voce: p.hasVoice, gain: net.gainOf(p.id),
  }))
  : []
;(window as unknown as Record<string, unknown>).__audioParams = AUDIO_PARAMS
;(window as unknown as Record<string, unknown>).__audioState = audioState
;(window as unknown as Record<string, unknown>).__audio = audio

// the physics capsule stays, but is hidden once the model is in place
const avatar = new THREE.Mesh(
  new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HALF * 2, 8, 16),
  new THREE.MeshBasicMaterial({ color: 0x59d0ff, wireframe: true }),
)
avatar.position.copy(SPAWN)
scene.add(avatar)

// character model rides on top of the capsule
// Quaternius Universal Base Characters (CC0) + Universal Animation Library.
// Il maschile e il femminile hanno lo stesso rig: si scambiano senza altro.
const CHARACTER_URL = q.get('body') === 'f'
  ? '/avatar/Superhero_Female_FullBody.gltf'
  : '/avatar/Superhero_Male_FullBody.gltf'
const ANIM_URL = '/avatar/anims.glb'
const CHARACTER_HEIGHT = 1.7
const charRoot = new THREE.Group()
scene.add(charRoot)

// body awareness: the spot cone is too narrow to catch your own torso at arm's
// length, so a short-range lamp rides the chest and lights the body only
// Kept well away from the body: a lamp a few centimetres from the torso blows
// out to white. Safe to be generous, because three.js lights do not affect the
// splat at all — this only reaches the character mesh and the props.
const bodyLight = new THREE.PointLight(0xffe6bf, DARK ? 2.2 : 0, 5, 1)
bodyLight.position.set(0, 2.1, 0.7)
charRoot.add(bodyLight)
let mixer: THREE.AnimationMixer | null = null
let actIdle: THREE.AnimationAction | null = null
let actWalk: THREE.AnimationAction | null = null
let actSit: THREE.AnimationAction | null = null
let walking = false
let charYaw = 0
// Lo sguardo e il busto sono due cose diverse: la testa gira subito, il corpo
// insegue. Fermi si puo' guardare di lato fino a BODY_LAG_MAX senza muovere le
// spalle; appena si cammina il busto si riallinea, perche' camminare di
// traverso rispetto al petto e' proprio quello che sembra sbagliato.
let bodyYaw = 0
const BODY_LAG_MAX = 0.75          // radianti, ~43 gradi
let bobPhase = 0

// ── first person with a visible body ─────────────────────────────────────────
// RobotExpressive keeps the head as its own mesh ("Head") separate from the
// "Head" bone, so we can ride the bone with the camera and hide just that mesh:
// arms, torso, legs and feet stay visible when you look down.
// first person is the default on a phone: the third-person camera needs a
// 4-unit tail behind you, which most touch-sized rooms do not have to give
// prima persona ovunque per default: e' la vista in cui il corpo si vede
let firstPerson = q.get('fp') !== '0'
// With TOUCH_LOOK the camera orientation comes from yaw/pitch in both views and
// PointerLockControls is never engaged; on desktop it still owns first person.
const TOUCH_LOOK = IS_TOUCH
let headBone: THREE.Object3D | null = null
let headMesh: THREE.Object3D | null = null
let charTemplate: THREE.Object3D | null = null
let charClips: THREE.AnimationClip[] = []
// Tarato sul banco (_avatar.html) con questo modello: sotto 0.12 il torace
// occlude tutto, sopra 0.25 il corpo esce dall'inquadratura e sembri
// disincarnato. A 0.16 si vedono torso e punte dei piedi insieme.
const EYE_FORWARD = 0.16
const look = new PointerLockControls(camera, document.body)
const _viewDir = new THREE.Vector3()

function applyViewMode() {
  // Questo modello e' UNA mesh skinnata continua: non c'e' un oggetto "testa"
  // da spegnere come sul robot. Si azzera la scala dell'osso, cosi' i vertici
  // pesati su di esso collassano in un punto e il resto del corpo resta.
  if (headBone) headBone.scale.setScalar(firstPerson ? 0.001 : 1)
  const el = document.getElementById('view')
  if (el) el.textContent = firstPerson ? '1ª persona' : '3ª persona'
}
addEventListener('keydown', e => {
  if (e.code !== 'KeyV' || e.repeat) return
  firstPerson = !firstPerson
  applyViewMode()
  if (TOUCH_LOOK) return                 // no pointer to lock on a touchscreen
  if (firstPerson) look.lock()
  else look.unlock()
})
// clicking the canvas grabs the mouse while in first person
renderer.domElement.addEventListener('click', () => {
  if (firstPerson && !TOUCH_LOOK) look.lock()
})

async function loadCharacter() {
  const loader = new GLTFLoader()
  // Corpo e animazioni sono due file: il modello Quaternius non ne porta
  // nessuna, ma la sua Universal Animation Library ha lo STESSO rig — 65 ossa
  // con gli stessi nomi — quindi le clip si applicano senza retargeting.
  const [gltf, anims] = await Promise.all([
    loader.loadAsync(CHARACTER_URL),
    loader.loadAsync(ANIM_URL),
  ])
  const model = gltf.scene
  // scale so the model is CHARACTER_HEIGHT tall, feet at the group origin
  const box = new THREE.Box3().setFromObject(model)
  const s = CHARACTER_HEIGHT / Math.max(1e-6, box.max.y - box.min.y)
  model.scale.setScalar(s)
  model.position.y = -box.min.y * s
  model.traverse(o => {
    if ((o as THREE.Mesh).isMesh) o.frustumCulled = false
    if (o.name === 'Head' && !(o as THREE.Mesh).isMesh) headBone = o
  })
  charRoot.add(model)
  // il modello e' gia' scalato con i piedi sull'origine del gruppo: e' il
  // template giusto da clonare per gli altri giocatori
  charTemplate = model
  charClips = anims.animations
  ;(window as unknown as Record<string, unknown>).__charRoot = charRoot

  mixer = new THREE.AnimationMixer(model)
  const clipIdle = THREE.AnimationClip.findByName(charClips, 'Idle_Loop')
  const clipWalk = THREE.AnimationClip.findByName(charClips, 'Walk_Loop')
  if (clipIdle) { actIdle = mixer.clipAction(clipIdle); actIdle.play() }
  if (clipWalk) { actWalk = mixer.clipAction(clipWalk); actWalk.enabled = true; actWalk.weight = 0; actWalk.play() }
  const clipSit = THREE.AnimationClip.findByName(charClips, 'Sitting_Idle_Loop')
  if (clipSit) { actSit = mixer.clipAction(clipSit); actSit.enabled = true; actSit.weight = 0; actSit.play() }
  avatar.visible = false          // hide the capsule now that the model is up
  applyViewMode()
  return {
    clips: charClips.map(a => a.name), height: CHARACTER_HEIGHT,
    headBone: !!headBone, headMesh: !!headBone,
  }
}

// ── camera rig ───────────────────────────────────────────────────────────────
let yaw = 0, pitch = -0.15, dragging = false, lastX = 0, lastY = 0
const PITCH_MIN = -1.2, PITCH_MAX = 0.6
renderer.domElement.addEventListener('pointerdown', e => {
  if (TOUCH_LOOK) return                 // the touch layer owns the pointer
  dragging = true; lastX = e.clientX; lastY = e.clientY
})
addEventListener('pointerup', () => { dragging = false })
addEventListener('pointermove', e => {
  if (TOUCH_LOOK) return
  if (!dragging || firstPerson) return   // in FP the mouse belongs to PointerLockControls
  yaw -= (e.clientX - lastX) * 0.005
  pitch = THREE.MathUtils.clamp(pitch - (e.clientY - lastY) * 0.005, -1.2, 0.6)
  lastX = e.clientX; lastY = e.clientY
})

// drag on the right half to look, stick on the left half to move
const stick = setupTouch({
  onLook: (dx, dy) => {
    yaw -= dx * 0.004
    pitch = THREE.MathUtils.clamp(pitch - dy * 0.004, PITCH_MIN, PITCH_MAX)
  },
  onTap: startAudio,
})
setupOrientationHint()

const keys = new Set<string>()
addEventListener('keydown', e => {
  keys.add(e.code)
  if (e.code === 'KeyE' && !e.repeat && !toggleSit()) pickOrDrop()
})
addEventListener('keyup', e => keys.delete(e.code))
// G indica: un anello dove stai guardando, che vedono anche gli altri
addEventListener('keydown', e => {
  if (e.code !== 'KeyG' || e.repeat) return
  const d = 3
  const px = charPos.x + Math.sin(charYaw) * d
  const pz = charPos.z + Math.cos(charYaw) * d
  pointer.show(px, charPos.y, pz)
  net?.sendPointer({ x: px, y: charPos.y, z: pz })
})

/** Nearest un-held prop within reach and roughly in front of the character. */
function propInFront(): Prop | null {
  const fx = Math.sin(charYaw), fz = Math.cos(charYaw)
  let best: Prop | null = null
  let bestDist = Infinity
  for (const p of props) {
    if (p.held) continue
    const t = p.body.translation()
    const dx = t.x - charRoot.position.x
    const dz = t.z - charRoot.position.z
    if (Math.abs(t.y - charRoot.position.y) > 1.5) continue
    const dist = Math.hypot(dx, dz)
    if (dist > PICK_RANGE || dist < 1e-4) continue
    if ((dx * fx + dz * fz) / dist < 0.3) continue    // must be ahead, not behind
    if (dist < bestDist) { bestDist = dist; best = p }
  }
  return best
}

function pickOrDrop() {
  if (GAME.over) return
  if (carried) {
    carried.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
    carried.body.setLinvel({ x: Math.sin(charYaw) * 1.5, y: 0.5, z: Math.cos(charYaw) * 1.5 }, true)
    const t = carried.body.translation()
    audio.thud(t.x, t.y, t.z)
    carried.held = false
    carried = null
    return
  }
  const p = propInFront()
  if (!p) return

  // targets and batteries are taken, not carried around
  if (p.kind === 'target' || p.kind === 'battery') {
    p.taken = true
    p.held = true
    p.mesh.visible = false
    p.body.setEnabled(false)
    const t = p.body.translation()
    audio.thud(t.x, t.y, t.z)
    if (p.kind === 'target') GAME.collected++
    else GAME.spares++
    pickedCount++
    updateHud()
    return
  }

  p.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true)
  p.held = true
  carried = p
  pickedCount++
}

// ── game rules ───────────────────────────────────────────────────────────────
const GAME = {
  battery: 1,
  batterySeconds: Number(q.get('batt') ?? 180),
  spares: 1,                       // one spare cell to start with (R to use it)
  timeLimit: Number(q.get('time') ?? 300),
  timeLeft: Number(q.get('time') ?? 300),
  targets: 5,
  collected: 0,
  over: false,
  won: false,
  score: 0,
  flicker: 1,                      // multiplies torch intensity, see the tick
}
const LOW_BATTERY = 0.2
const EXIT_RADIUS = 1.6
;(window as unknown as Record<string, unknown>).__game = GAME
let exitPos: THREE.Vector3 | null = null
let exitMarker: THREE.Mesh | null = null

function updateHud() {
  if (objCountEl) objCountEl.textContent = `${GAME.collected} / ${GAME.targets}`
  if (timeLeftEl) {
    timeLeftEl.textContent = fmtTime(GAME.timeLeft)
    timeLeftEl.classList.toggle('warn', GAME.timeLeft < 60)
  }
  if (battFillEl) {
    battFillEl.style.width = `${Math.max(0, GAME.battery * 100)}%`
    battFillEl.style.background = GAME.battery < LOW_BATTERY ? 'var(--danger)' : 'var(--accent)'
  }
}

function fmtTime(sec: number) {
  const s = Math.max(0, Math.ceil(sec))
  return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`
}

function endGame(won: boolean, reason: string) {
  if (GAME.over) return
  GAME.over = true
  GAME.won = won
  const timeUsed = GAME.timeLimit - GAME.timeLeft
  // full marks for everything found, part marks for leaving early, nothing for
  // running out of time — leaving with less is a choice, not a failure
  GAME.score = won
    ? Math.round(1000 * (GAME.collected / GAME.targets) + Math.max(0, GAME.timeLeft) * 2)
    : 0
  const v = document.getElementById('overVerdict')
  if (v) {
    v.textContent = reason
    v.classList.toggle('lose', !won)
  }
  const set = (id: string, val: string) => {
    const el = document.getElementById(id)
    if (el) el.textContent = val
  }
  set('ovObj', `${GAME.collected} / ${GAME.targets}`)
  set('ovTime', fmtTime(timeUsed))
  set('ovScore', String(GAME.score))
  overEl?.classList.remove('hidden')
  document.exitPointerLock?.()
}

document.getElementById('btnAgain')?.addEventListener('click', () => location.reload())
document.getElementById('btnMaps')?.addEventListener('click', () => { location.href = '/home.html' })

// ── props ────────────────────────────────────────────────────────────────────
type Prop = {
  name: string; mesh: THREE.Mesh; body: RAPIER.RigidBody; held: boolean
  kind: 'target' | 'battery' | 'junk'
  taken?: boolean
}
const props: Prop[] = []

type HFData = {
  G: number; nrows: number; ncols: number; heights: number[]; wallLevel: number
  scale: { x: number; y: number; z: number }; center: { x: number; y: number; z: number }
}
let hfData: HFData | null = null

/**
 * Pick spots on walkable, near-floor cells that are far apart from each other
 * and from the spawn — so the five objects are a tour of the map, not a pile.
 */
function pickSpots(n: number, minGap: number, from: THREE.Vector3): { x: number; y: number; z: number }[] {
  const hf = hfData
  if (!hf) return []
  const G = hf.G, W = hf.wallLevel
  const minX = hf.center.x - hf.scale.x / 2, minZ = hf.center.z - hf.scale.z / 2
  const cw = hf.scale.x / (G - 1), cd = hf.scale.z / (G - 1)
  const valid = hf.heights.filter(v => v < W - 1)
  if (!valid.length) return []
  const sorted = [...valid].sort((a, b) => a - b)
  const floor = sorted[(sorted.length * 0.1) | 0]

  const cand: { x: number; y: number; z: number }[] = []
  for (let iz = 2; iz < G - 2; iz++) {
    for (let jx = 2; jx < G - 2; jx++) {
      const h = hf.heights[iz + jx * G]
      if (h >= W - 1 || h > floor + 0.6) continue
      // require the 4 neighbours to be walkable too: no perching on a ledge
      let ok = true
      for (const [dz, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nb = hf.heights[(iz + dz) + (jx + dx) * G]
        if (nb >= W - 1 || Math.abs(nb - h) > 0.25) { ok = false; break }
      }
      if (ok) cand.push({ x: minX + jx * cw, y: h, z: minZ + iz * cd })
    }
  }
  if (!cand.length) return []

  // farthest-point sampling: each new spot is the candidate furthest from all
  // the ones already chosen, which spreads them without any hand-tuning
  const chosen: { x: number; y: number; z: number }[] = []
  const anchors = [{ x: from.x, y: from.y, z: from.z }]
  for (let k = 0; k < n; k++) {
    let best = null as null | { x: number; y: number; z: number }
    let bestD = -1
    for (const c of cand) {
      let d = Infinity
      for (const a of [...anchors, ...chosen]) d = Math.min(d, Math.hypot(c.x - a.x, c.z - a.z))
      if (d > bestD) { bestD = d; best = c }
    }
    if (!best || bestD < minGap * 0.35) break
    chosen.push(best)
  }
  return chosen
}
let carried: Prop | null = null
let pickedCount = 0
const hintEl = document.getElementById('hint') as HTMLElement

const PICK_RANGE = 1.6
const CARRY_AHEAD = 0.55
const CARRY_HEIGHT = 0.35

// ── world ────────────────────────────────────────────────────────────────────
async function boot() {
  await RAPIER.init()
  const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 })

  // 1a. heightfield mode: one ground height per grid vertex
  let colliderCount = 0
  let splatQuat: THREE.Quaternion | null = null
  if (HEIGHTFIELD_URL) {
    const hfRes = await fetch(HEIGHTFIELD_URL)
    if (!hfRes.ok) { fail(`Missing ${HEIGHTFIELD_URL} (${hfRes.status}).`); return }
    const hf = await hfRes.json() as HFData & {
      quaternion?: { x: number; y: number; z: number; w: number }
    }
    // the heightfield was built on the upright scene — rotate the splat to match
    if (hf.quaternion) {
      const k = hf.quaternion
      splatQuat = new THREE.Quaternion(k.x, k.y, k.z, k.w)
    }
    hfData = hf
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(hf.center.x, hf.center.y, hf.center.z),
    )
    world.createCollider(
      RAPIER.ColliderDesc.heightfield(hf.nrows, hf.ncols, new Float32Array(hf.heights), hf.scale),
      body,
    )
    colliderCount = 1
  } else {

  // 1b. colliders from the exported .glb → static trimeshes
  const res = await fetch(COLLIDER_URL)
  if (!res.ok) {
    fail(`Missing ${COLLIDER_URL} (${res.status}). Export colliders from the builder into public/.`)
    return
  }
  const gltf = await new GLTFLoader().parseAsync(await res.arrayBuffer(), '')
  gltf.scene.updateWorldMatrix(true, true)
  gltf.scene.traverse(obj => {
    const m = obj as THREE.Mesh
    if (!m.isMesh || !m.geometry) return
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld)
    const pos = g.getAttribute('position') as THREE.BufferAttribute
    const idx = g.getIndex()
    if (!pos || !idx) return
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(
      RAPIER.ColliderDesc.trimesh(new Float32Array(pos.array), new Uint32Array(idx.array)),
      body,
    )
    colliderCount++
  })
  if (!colliderCount) { fail('No meshes found in colliders.glb'); return }

  }

  // 2. character: kinematic capsule + Rapier's character controller
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(SPAWN.x, SPAWN.y, SPAWN.z),
  )
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(CAPSULE_HALF, CAPSULE_RADIUS), body)

  const controller = world.createCharacterController(0.02)
  controller.setUp({ x: 0, y: 1, z: 0 })
  controller.enableAutostep(0.45, 0.2, true)      // step-offset: climb small ledges
  controller.enableSnapToGround(0.4)              // stick to floor going downhill
  controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180)
  controller.setMinSlopeSlideAngle((35 * Math.PI) / 180)
  controller.setApplyImpulsesToDynamicBodies(true)   // so walking into props pushes them
  controller.setCharacterMass(70)

  // dynamic props, dropped a little above the spawn
  const addProp = (kind: Prop['kind'], name: string, at: { x: number; y: number; z: number }, colour: number, size: number) => {
    const mesh = new THREE.Mesh(
      kind === 'battery'
        ? new THREE.CylinderGeometry(size * 0.6, size * 0.6, size * 2, 14)
        : new THREE.BoxGeometry(size * 2, size * 2, size * 2),
      new THREE.MeshStandardMaterial({
        color: colour, roughness: 0.4, metalness: 0.3,
        // targets glow a little so the torch beam picks them out of the dark
        emissive: colour, emissiveIntensity: kind === 'junk' ? 0 : 0.5,
      }),
    )
    mesh.frustumCulled = false
    scene.add(mesh)
    const rb = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(at.x, at.y + 0.4, at.z)
        .setLinearDamping(0.4).setAngularDamping(0.6),
    )
    world.createCollider(
      (kind === 'battery'
        ? RAPIER.ColliderDesc.cylinder(size, size * 0.6)
        : RAPIER.ColliderDesc.cuboid(size, size, size)
      ).setDensity(0.4).setFriction(0.9).setRestitution(0.1), rb)
    props.push({ name, mesh, body: rb, held: false, kind })
  }

  if (MAP.props && !explicit) {     // explicit splat= means a bare test scene
    const spots = pickSpots(GAME.targets + 2, 6, SPAWN)
    const names = ['reperto', 'cassetta', 'lanterna', 'taccuino', 'chiave']
    spots.slice(0, GAME.targets).forEach((s, i) =>
      addProp('target', names[i] ?? `oggetto ${i + 1}`, s, 0xe0a458, 0.22))
    // spare cells sit further out, as a detour
    spots.slice(GAME.targets).forEach((s, i) =>
      addProp('battery', `batteria ${i + 1}`, s, 0x6fd6c4, 0.14))

    // exit: the furthest walkable spot from the spawn, marked by a light shaft
    const exitSpots = pickSpots(1, 0, SPAWN)
    if (exitSpots.length) {
      exitPos = new THREE.Vector3(exitSpots[0].x, exitSpots[0].y, exitSpots[0].z)
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 1.5, 14, 18, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xe0a458, transparent: true, opacity: 0.14,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      )
      shaft.position.set(exitPos.x, exitPos.y + 7, exitPos.z)
      shaft.frustumCulled = false
      scene.add(shaft)
      exitMarker = shaft
      ;(GAME as Record<string, unknown>).exit = { x: exitPos.x, y: exitPos.y, z: exitPos.z }
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.1, 1.5, 32),
        new THREE.MeshBasicMaterial({ color: 0xe0a458, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.set(exitPos.x, exitPos.y + 0.05, exitPos.z)
      scene.add(ring)
    }
    updateHud()
  }

  // 3. the splat itself (visual only, no physics)
  setLoad(0, 'scaricamento scena')
  let splatBytes: ArrayBuffer
  try {
    splatBytes = await loadBytes(splatUrl, f => setLoad(f * 0.85, 'scaricamento scena'))
  } catch (e) {
    // the heavy build is not deployed; fall back rather than showing an error
    if (splatUrl === MAP.light) throw e
    console.warn(`${splatUrl} non disponibile, passo alla variante leggera`, e)
    splatUrl = MAP.light
    setLoad(0, 'variante leggera')
    splatBytes = await loadBytes(splatUrl, f => setLoad(f * 0.85, 'scaricamento scena'))
  }
  setLoad(0.88, 'decodifica gaussiane')
  const splat = new SplatMesh({
    fileBytes: splatBytes,
    fileName: splatUrl.split('/').pop() ?? 'attic.spz',
    fileType: fileTypeOf(splatUrl),
    lod: splatUrl.endsWith('.spz'),
  })
  if (splatQuat) splat.quaternion.copy(splatQuat)
  if (DARK) splat.worldModifier = makeTorchModifier()
  scene.add(splat)
  let splatReady = false
  splat.initialized.then(() => {
    splatReady = true
    setLoad(1, 'pronto')
    // la richiesta del microfono arriva quando la scena e' visibile, non
    // sopra la schermata di caricamento
    if (net && !net.micReady && !net.micDenied) {
      setTimeout(() => micAskEl?.classList.add('on'), 900)
    }
    setTimeout(() => loadingEl?.classList.add('hidden'), 220)
  })

  // character model (physics does not depend on it, so failure is non-fatal)
  let charInfo: { clips: string[]; height: number } | null = null
  try {
    charInfo = await loadCharacter()
  } catch (e) {
    console.warn('character model not loaded:', e)
  }

  let vy = 0
  const prevPos = new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z)
  // test hook: drop the character at an arbitrary spot without reloading the splat
  // test hook: aim the first-person camera without a real mouse
  ;(window as unknown as Record<string, unknown>).__look = (yawDeg: number, pitchDeg: number) => {
    camera.rotation.set(THREE.MathUtils.degToRad(pitchDeg), THREE.MathUtils.degToRad(yawDeg), 0, 'YXZ')
  }
  ;(window as unknown as Record<string, unknown>).__setView = (fp: boolean) => {
    firstPerson = fp
    applyViewMode()
  }
  ;(window as unknown as Record<string, unknown>).__respawn = (x: number, y: number, z: number) => {
    // setTranslation teleports now; setNextKinematicTranslation would be
    // overwritten by the animation loop before the next step.
    body.setTranslation({ x, y, z }, true)
    vy = 0
  }
  const clock = new THREE.Clock()
  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), wish = new THREE.Vector3()

  let introStart = 0
  let lastReal = performance.now()
  let fpsFrames = 0, fpsSince = performance.now(), fpsNow = 0
  let beaconT = 0, fading = false
  renderer.setAnimationLoop(() => {
    const nowReal = performance.now()
    const realDt = Math.min((nowReal - lastReal) / 1000, 0.25)
    lastReal = nowReal
    const dt = Math.min(clock.getDelta(), 0.05)

    // ── intro: fully lit, then the light drains away ────────────────────────
    // the intro must start when the player can actually SEE the scene, not when
    // the loop starts: the splat is still decoding behind the loading screen
    if (DARK && splatReady && introT <= INTRO_HOLD + INTRO_FADE) {
      // wall-clock, not the clamped physics dt: at 15 FPS a clamped dt runs the
      // intro (and the timer) at 75% speed
      introT = introStart === 0 ? (introStart = performance.now(), 0)
        : (performance.now() - introStart) / 1000
      const raw = introT < INTRO_HOLD
        ? 1
        : 1 - Math.min(1, (introT - INTRO_HOLD) / INTRO_FADE)
      const k = raw * raw * (3 - 2 * raw)            // smoothstep, no linear ramp
      torchAmbient.value = AMBIENT_FLOOR + (1 - AMBIENT_FLOOR) * k
      // during the lit intro you must see the whole place, so the cull distance
      // opens up with the light and closes back down as it drains. Multiplying
      // (rather than lerping towards a huge number) keeps the ramp smooth.
      if (cullOn) {
        const grow = 1 + k * 40
        cullNear.value = cullBase * grow
        cullFar.value = (cullBase + CULL_FADE) * grow
      }
      hemi.intensity = HEMI_DARK + (HEMI_LIT - HEMI_DARK) * k
      sun.intensity = SUN_DARK + (SUN_LIT - SUN_DARK) * k
      if (titleEl) {
        const fadeIn = Math.min(1, introT / 0.8)
        const fadeOut = 1 - Math.min(1, Math.max(0, introT - (INTRO_HOLD + INTRO_FADE * 0.4)) / 1.2)
        titleEl.style.opacity = String(Math.min(fadeIn, fadeOut))
      }
    } else if (DARK && splatReady && titleEl && titleEl.style.opacity !== '0') {
      titleEl.style.opacity = '0'
    }

    // on touch the camera is ours to aim: PointerLockControls never runs, so
    // first person reads the same yaw/pitch the third-person rig uses
    if (TOUCH_LOOK && firstPerson) camera.rotation.set(pitch, yaw, 0, 'YXZ')

    // desired horizontal movement, relative to where the camera looks
    if (firstPerson) {
      camera.getWorldDirection(_viewDir)
      fwd.set(_viewDir.x, 0, _viewDir.z).normalize()
      right.set(-fwd.z, 0, fwd.x)
    } else {
      fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw))
      right.set(Math.cos(yaw), 0, -Math.sin(yaw))
    }
    wish.set(0, 0, 0)
    if (keys.has('KeyW')) wish.add(fwd)
    if (keys.has('KeyS')) wish.sub(fwd)
    if (keys.has('KeyD')) wish.add(right)
    if (keys.has('KeyA')) wish.sub(right)
    // the stick is analogue, but wish gets normalised below, so it only sets a
    // direction — pushing it to the rim is what asks for the running speed
    if (stick.x || stick.y) {
      wish.addScaledVector(fwd, stick.y).addScaledVector(right, stick.x)
    }
    if (sitting) wish.set(0, 0, 0)          // da seduti si resta seduti
    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') || stick.run
      ? RUN_SPEED : WALK_SPEED
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed * dt)

    // gravity integrated manually — the controller only resolves the sweep
    vy += GRAVITY * dt

    controller.computeColliderMovement(collider, { x: wish.x, y: vy * dt, z: wish.z })
    const mv = controller.computedMovement()
    const p = body.translation()
    body.setNextKinematicTranslation({ x: p.x + mv.x, y: p.y + mv.y, z: p.z + mv.z })
    world.step()

    const np = body.translation()
    avatar.position.set(np.x, np.y, np.z)
    charPos.x = np.x
    charPos.y = np.y - (CAPSULE_HALF + CAPSULE_RADIUS)
    charPos.z = np.z
    if (controller.computedGrounded()) vy = 0

    // model rides the capsule: feet at its base
    charRoot.position.set(np.x, np.y - (CAPSULE_HALF + CAPSULE_RADIUS), np.z)
    // face the direction of travel (model looks down +Z), eased so it doesn't snap
    const moving = wish.lengthSq() > 1e-8
    if (firstPerson) {
      charYaw = Math.atan2(_viewDir.x, _viewDir.z)
      let d = charYaw - bodyYaw
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      if (moving) bodyYaw += d * Math.min(1, dt * 7)        // camminando ci si allinea
      else if (Math.abs(d) > BODY_LAG_MAX) {                // fermi, solo oltre il limite
        bodyYaw += (Math.abs(d) - BODY_LAG_MAX) * Math.sign(d)
      }
      charRoot.rotation.y = bodyYaw
    } else {
      if (moving) charYaw = Math.atan2(wish.x, wish.z)
      let d = charYaw - charRoot.rotation.y
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      charRoot.rotation.y += d * Math.min(1, dt * 12)
    }
    // blend idle <-> walk
    if (moving !== walking) walking = moving
    if (actSit) {
      // la seduta prende il sopravvento sulle altre due, in dissolvenza
      actSit.weight += ((sitting ? 1 : 0) - actSit.weight) * Math.min(1, dt * 5)
    }
    if (actWalk && actIdle) {
      const sit = actSit?.weight ?? 0
      const w = THREE.MathUtils.clamp(actWalk.weight + (walking ? 1 : -1) * dt * 6, 0, 1) * (1 - sit)
      actWalk.weight = w
      actIdle.weight = (1 - w) * (1 - sit)
    }
    mixer?.update(dt)

    // props follow their rigid bodies; the carried one is driven by the character
    for (const p of props) {
      if (p.held) continue
      const t = p.body.translation(), r = p.body.rotation()
      p.mesh.position.set(t.x, t.y, t.z)
      p.mesh.quaternion.set(r.x, r.y, r.z, r.w)
    }
    if (carried) {
      const hx = np.x + Math.sin(charYaw) * CARRY_AHEAD
      const hz = np.z + Math.cos(charYaw) * CARRY_AHEAD
      const hy = np.y + CARRY_HEIGHT
      carried.body.setNextKinematicTranslation({ x: hx, y: hy, z: hz })
      carried.mesh.position.set(hx, hy, hz)
      carried.mesh.rotation.set(0, charYaw, 0)
    }
    const near = carried ? null : propInFront()
    hintEl.textContent = carried
      ? `E per lasciare ${carried.name}`
      : near ? `E per raccogliere ${near.name}` : ''

    if (firstPerson) {
      // La camera NON sta sull'osso della testa. Agganciarcela sembra la cosa
      // giusta ma eredita il beccheggio dell'animazione: il quadro balla a ogni
      // passo e trema anche da fermi. Gli sparatutto in prima persona tengono
      // la camera su una posizione logica — capsula piu' altezza occhi — e
      // lasciano che sia il corpo a seguirla. Cosi' lo sguardo e' fermo.
      const eyeY = np.y + (CHARACTER_HEIGHT * 0.94 - (CAPSULE_HALF + CAPSULE_RADIUS))
      // l'occhio sta davanti al PETTO, quindi segue il busto e non lo sguardo:
      // altrimenti girando la testa la camera scivolerebbe fuori dal corpo
      camera.position.set(
        np.x + Math.sin(bodyYaw) * EYE_FORWARD,
        eyeY,
        np.z + Math.cos(bodyYaw) * EYE_FORWARD,
      )
      // Oscillazione sintetica: piccola, regolare e legata alla DISTANZA
      // percorsa, non a un timer — resta agganciata al passo a qualunque frame
      // rate, come i suoni. Verticale a frequenza doppia (due appoggi per
      // falcata), laterale a frequenza singola.
      if (moving) {
        bobPhase += (speed * dt) * (Math.PI / 0.85)
        const amt = Math.min(1, speed / WALK_SPEED)
        camera.position.y += Math.sin(bobPhase * 2) * 0.021 * amt
        camera.position.x += right.x * Math.sin(bobPhase) * 0.013 * amt
        camera.position.z += right.z * Math.sin(bobPhase) * 0.013 * amt
      }
    } else {
      // third-person camera
      const target = new THREE.Vector3(np.x, np.y + 0.4, np.z)
      const dist = 4
      camera.position.set(
        target.x + Math.sin(yaw) * Math.cos(pitch) * dist,
        target.y - Math.sin(pitch) * dist,
        target.z + Math.cos(yaw) * Math.cos(pitch) * dist,
      )
      camera.lookAt(target)
    }

    // ── torch life, timer, exit ─────────────────────────────────────────────
    const playing = DARK && !GAME.over && introT > INTRO_HOLD
    if (playing) {
      if (torchOn && GAME.battery > 0) {
        GAME.battery = Math.max(0, GAME.battery - realDt / GAME.batterySeconds)
        if (GAME.battery === 0) { torchOn = false; audio.torchClick(false) }
      }
      GAME.timeLeft = Math.max(0, GAME.timeLeft - realDt)
      if (GAME.timeLeft === 0) endGame(false, 'TEMPO SCADUTO')

      audioState.battery = GAME.battery
      audioState.torchOn = torchOn
      audioState.timeFraction = GAME.timeLeft / GAME.timeLimit
      audioState.allCollected = GAME.collected >= GAME.targets

      // a torch is never perfectly steady; under 20% it stutters badly
      const t2 = performance.now() / 1000
      const idle = 0.94 + Math.sin(t2 * 11.3) * 0.03 + Math.sin(t2 * 27.7) * 0.02
      if (GAME.battery < LOW_BATTERY && GAME.battery > 0) {
        const panic = 1 - GAME.battery / LOW_BATTERY
        GAME.flicker = Math.random() < 0.06 + panic * 0.22
          ? Math.random() * 0.25            // a dropout
          : idle * (1 - panic * 0.25)
      } else GAME.flicker = idle
      if (performance.now() < flickerUntil && Math.random() < 0.35) GAME.flicker *= 0.25
      audioState.hush = performance.now() < hushUntil

      // reaching the exit ends the run: with everything, or with what you have
      if (exitPos) {
        const d = Math.hypot(np.x - exitPos.x, np.z - exitPos.z)
        if (d < EXIT_RADIUS && Math.abs(np.y - exitPos.y) < 3) {
          endGame(true, GAME.collected >= GAME.targets ? 'FUGA COMPLETA' : 'FUGA PARZIALE')
        }
      }
      updateHud()
    }
    if (exitMarker) exitMarker.rotation.y += dt * 0.15

    // These two feed both the torch cone and the culling cone, so they are
    // updated even with the lights on (explore mode): off-screen culling stays
    // on always, and a stale camera position would cull the wrong half of the room.
    torchPos.value.copy(camera.position)
    camera.getWorldDirection(torchDir.value)
    // cone that circumscribes the frustum, widened by the margin
    if (fcullOn) {
      const vt = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))
      const corner = Math.atan(Math.hypot(vt, vt * camera.aspect))
      cullCos.value = Math.cos(Math.min(corner + FCULL_MARGIN, Math.PI * 0.49))
    }

    // torch follows the camera: same position and aim for splat shader and spotlight
    if (DARK) {
      // in first person the spot must start beyond your own chest, or looking
      // down blasts the torso white from point-blank range
      const spotAhead = firstPerson ? 0.75 : 0
      torch.position.copy(camera.position).addScaledVector(torchDir.value, spotAhead)
      torchTarget.position.copy(torch.position).add(torchDir.value)
      // F kills the beam: the splat modifier reads torchRange, the mesh the spotlight
      const lit = torchOn && GAME.battery > 0 ? GAME.flicker : 0
      torchRange.value = lit > 0 ? TORCH_RANGE * (0.75 + lit * 0.25) : 0.5
      torch.intensity = 40 * lit
      torch.distance = torchRange.value * 1.4
      bodyLight.intensity = lit > 0 ? 2.2 * lit : 0.5
    }

    // audio: listener on the camera, footsteps driven by real ground speed
    const vx = np.x - prevPos.x, vz = np.z - prevPos.z
    const groundSpeed = dt > 0 ? Math.hypot(vx, vz) / dt : 0
    prevPos.set(np.x, np.y, np.z)
    camera.getWorldDirection(_viewDir)
    audio.setListener(camera.position.x, camera.position.y, camera.position.z,
      _viewDir.x, _viewDir.y, _viewDir.z)
    audio.update(dt, audioState, { x: np.x, y: np.y, z: np.z }, groundSpeed,
      keys.has('ShiftLeft') || keys.has('ShiftRight'))

    // ── presenza: manda la propria posa, disegna quelle degli altri ─────────
    if (net) {
      if (!peers && charTemplate) {
        peers = new Peers(scene, charTemplate, charClips, CHARACTER_HEIGHT)
      }
      const move: Move = {
        x: +np.x.toFixed(3),
        // gli altri ci vedono coi piedi per terra, non al centro della capsula
        y: +(np.y - (CAPSULE_HALF + CAPSULE_RADIUS)).toFixed(3),
        z: +np.z.toFixed(3),
        yaw: +charYaw.toFixed(3),
        w: moving ? 1 : 0,
      }
      net.broadcast(move)
      // La distanza va misurata fra i PERSONAGGI, non dalla camera: in terza
      // persona la camera sta 4 unita' dietro, e girandosi il volume cambiava
      // senza che nessuno si fosse mosso. `move` e' gia' la nostra posa ai
      // piedi, la stessa convenzione con cui arrivano quelle degli altri.
      net.update(move.x, move.y, move.z)
      peers?.update(net, dt, camera)
      updateMicUi()
    }

    pointer.update()

    // ── il direttore, i fari degli obiettivi, i portali ────────────────────
    if (DARK && !GAME.over && introT > INTRO_HOLD) {
      const ev = director.update(realDt, {
        timeFraction: GAME.timeLeft / GAME.timeLimit,
        battery: GAME.battery, collected: GAME.collected, targets: GAME.targets,
        x: charPos.x, y: charPos.y, z: charPos.z,
      })
      if (ev) {
        // la minaccia e' solo suono: nessun corpo, nessuna conseguenza
        if (ev.kind === 'steps') for (let i = 0; i < 4; i++)
          setTimeout(() => spatialTone(ev.x, ev.y + 0.1, ev.z, 90 + i * 6, 0.13, 0.32, 'triangle'), i * 380)
        else if (ev.kind === 'breath') spatialTone(ev.x, ev.y + 1.4, ev.z, 62, 1.6, 0.22, 'sine')
        else if (ev.kind === 'thud') spatialTone(ev.x, ev.y, ev.z, 48, 0.5, 0.5, 'sine')
        else if (ev.kind === 'hush') hushUntil = performance.now() + 2600
        else if (ev.kind === 'flicker') flickerUntil = performance.now() + 1800
      }
      // ogni obiettivo ancora da prendere chiama piano, ma solo da vicino
      beaconT += realDt
      if (beaconT > 1.4) {
        beaconT = 0
        for (const pr of props) {
          if (pr.taken || pr.kind !== 'target') continue
          const t = pr.body.translation()
          const d = Math.hypot(t.x - charPos.x, t.z - charPos.z)
          if (d < 10) spatialTone(t.x, t.y, t.z, 880, 0.22, 0.055 * (1 - d / 10), 'sine')
        }
      }
    }

    // portale: entrarci cambia mappa senza sciogliere la stanza
    if (!fading) {
      const pt = places.nearest('portal', charPos.x, charPos.z, 1.1)
      if (pt?.map) {
        fading = true
        document.body.classList.add('fade')
        const p2 = new URLSearchParams(location.search)
        p2.set('map', pt.map)
        setTimeout(() => { location.search = p2.toString() }, 900)
      }
    }

    renderer.render(scene, camera)

    // rolling frame rate over the last second, plus what the renderer actually
    // drew: render.triangles tracks the splat instances that survived culling
    fpsFrames++
    if (nowReal - fpsSince >= 1000) {
      fpsNow = (fpsFrames * 1000) / (nowReal - fpsSince)
      fpsFrames = 0
      fpsSince = nowReal
    }

    const grounded = controller.computedGrounded()
    stateEl.textContent =
      `colliders ${colliderCount} · splat ${splatReady ? 'ok' : '…'} · ` +
      `pos ${np.x.toFixed(2)} ${np.y.toFixed(2)} ${np.z.toFixed(2)} · ${grounded ? 'GROUNDED' : 'falling'}`
    ;(window as unknown as Record<string, unknown>).__CHAR = {
      x: np.x, y: np.y, z: np.z, grounded, splatReady, colliderCount,
      model: !!charInfo, clips: charInfo?.clips.length ?? 0,
      anim: walking ? 'Walking' : 'Idle', facing: +charRoot.rotation.y.toFixed(2),
      fp: firstPerson, headBone: !!headBone, headMesh: !!headMesh,
      headHidden: headMesh ? !headMesh.visible : null,
      props: props.length, picked: pickedCount, carrying: carried?.name ?? null,
      near: near?.name ?? null,
      fps: +fpsNow.toFixed(1), fov: camera.fov, touch: IS_TOUCH, quality: QUALITY,
      cull: cullOn ? +cullNear.value.toFixed(1) : 0,
      drawn: renderer.info.render.triangles,
      calls: renderer.info.render.calls,
      propPos: props.map(p => {
        const t = p.body.translation()
        return { n: p.name, kind: p.kind, x: +t.x.toFixed(2), y: +t.y.toFixed(2), z: +t.z.toFixed(2), held: p.held, taken: !!p.taken }
      }),
    }
  })
}

// ── porta d'ingresso ─────────────────────────────────────────────────────────
// Senza `mode` si mostra la scelta e non si scarica niente. I due bottoni
// ricaricano la pagina con la modalita' scelta: costa un reload di una pagina
// vuota e tiene il resto del codice ignaro dell'esistenza di un menu.
const chooseEl = document.getElementById('choose')
if (!MODE) {
  const shot = document.getElementById('chShot') as HTMLImageElement | null
  if (shot) shot.src = `/thumbs/${MAP.id}.jpg`
  const name = document.getElementById('chName')
  if (name) name.textContent = MAP.label
  const meta = document.getElementById('chMeta')
  if (meta) meta.textContent = `${MAP.sub} · ${MAP.area} m² · ${MAP.walkable.toFixed(0)}% agibile`
  chooseEl?.classList.add('on')
  const go = (mode: string) => () => {
    const p = new URLSearchParams(location.search)
    p.set('mode', mode)
    location.search = p.toString()
  }
  document.getElementById('chExplore')?.addEventListener('click', go('explore'))
  document.getElementById('chPlay')?.addEventListener('click', go('game'))
} else {
  chooseEl?.remove()
  // i comandi si presentano e poi si tolgono di mezzo
  setTimeout(() => document.getElementById('keys')?.classList.add('gone'), 8000)
  boot().catch(e => fail(String(e?.message ?? e)))
}
