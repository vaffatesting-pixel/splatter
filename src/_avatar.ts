// Banco di prova per scegliere l'avatar. Locale, non entra nel gioco.
//
//   /_avatar.html?m=/_src/Soldier.glb            terza persona, 3/4
//   /_avatar.html?m=/_src/Soldier.glb&view=fp    prima persona: si vedono i piedi?
//   /_avatar.html?m=/_src/Xbot.glb&clip=walk&hide=1&eye=0.12
//
// Il parametro che conta e' `eye`: quanto avanti sta l'occhio rispetto all'osso
// della testa. Troppo poco e la camera resta dentro il cranio, troppo e scivola
// fuori dalla faccia. Si tara guardando in basso, non davanti.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const q = new URLSearchParams(location.search)
const URL_M = q.get('m') ?? '/character.glb'
const HEIGHT = Number(q.get('h') ?? 1.7)
const VIEW = q.get('view') ?? 'tp'
const HIDE = q.get('hide') !== '0'
const EYE = Number(q.get('eye') ?? 0.1)
const PITCH = THREE.MathUtils.degToRad(Number(q.get('pitch') ?? -55))

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x14161a)
scene.add(new THREE.HemisphereLight(0xcfd4dc, 0x33333a, 2.4))
const sun = new THREE.DirectionalLight(0xffffff, 1.8)
sun.position.set(3, 6, 4)
scene.add(sun)
const grid = new THREE.GridHelper(6, 12, 0x3a4048, 0x23272d)
scene.add(grid)

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 100)
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

const hud = document.getElementById('hud')!
const clock = new THREE.Clock()

new GLTFLoader().load(URL_M, gltf => {
  const model = gltf.scene
  const box0 = new THREE.Box3().setFromObject(model)
  const raw = box0.max.y - box0.min.y
  const s = HEIGHT / Math.max(1e-6, raw)
  model.scale.setScalar(s)
  model.position.y = -box0.min.y * s
  model.traverse(o => { if ((o as THREE.Mesh).isMesh) o.frustumCulled = false })
  scene.add(model)

  // osso della testa: qui non c'e' una mesh separata da spegnere, quindi la
  // si fa collassare azzerandone la scala
  let head: THREE.Object3D | null = null
  model.traverse(o => {
    if (!head && /head$/i.test(o.name) && !/end|top/i.test(o.name)) head = o
  })
  if (HIDE && VIEW === 'fp' && head) (head as THREE.Object3D).scale.setScalar(0.001)

  const mixer = new THREE.AnimationMixer(model)
  const want = (q.get('clip') ?? 'idle').toLowerCase()
  // `?anim=` carica le clip da un file separato: funziona senza retargeting
  // solo se i due rig hanno gli stessi nomi di ossa (Quaternius: 65 su 65).
  const pick = (list: THREE.AnimationClip[]) =>
    list.find(a => a.name.toLowerCase() === want)
    ?? list.find(a => a.name.toLowerCase().includes(want))
    ?? list[0]
  const animUrl = q.get('anim')
  if (animUrl) {
    new GLTFLoader().load(animUrl, ag => {
      const c = pick(ag.animations)
      if (c) mixer.clipAction(c).play()
      ;(window as unknown as Record<string, unknown>).__CLIPS = ag.animations.map(a => a.name)
      hud.textContent += `\nclip esterna: ${c?.name ?? 'nessuna'} (${ag.animations.length} disponibili)`
    })
  } else {
    const clip = pick(gltf.animations)
    if (clip) mixer.clipAction(clip).play()
  }

  const box = new THREE.Box3().setFromObject(model)
  const _p = new THREE.Vector3()

  const info = {
    file: URL_M,
    altezzaOriginale: +raw.toFixed(3),
    scala: +s.toFixed(4),
    clip: want,
    clips: gltf.animations.map(a => a.name),
    ossaHead: head ? (head as THREE.Object3D).name : 'NESSUNA',
    larghezzaSpalle: +(box.max.x - box.min.x).toFixed(3),
    profondita: +(box.max.z - box.min.z).toFixed(3),
    eye: EYE,
  }
  ;(window as unknown as Record<string, unknown>).__A = info
  hud.textContent = Object.entries(info)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n')

  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta()
    mixer.update(dt)
    if (VIEW === 'fp' && head) {
      (head as THREE.Object3D).getWorldPosition(_p)
      // I rig Mixamo guardano verso +Z, la camera di three verso -Z: senza
      // questa mezza rotazione si guarderebbe la nuca invece che avanti.
      camera.position.set(_p.x, _p.y + Number(q.get('eyeY') ?? -0.04), _p.z + EYE)
      camera.rotation.set(PITCH, Math.PI, 0, 'YXZ')
    } else {
      camera.position.set(1.6, HEIGHT * 0.75, 2.4)
      camera.lookAt(0, HEIGHT * 0.5, 0)
    }
    renderer.render(scene, camera)
  })
}, undefined, e => { hud.textContent = 'ERRORE: ' + e })
