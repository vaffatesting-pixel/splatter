// Il lato visibile della presenza: un avatar per ogni altro giocatore, con
// interpolazione, targhetta col nome e anello che si accende quando parla.
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { Net, Peer } from './net'

/**
 * Ritardo di riproduzione. Gli aggiornamenti arrivano a 10 Hz e non a
 * intervalli regolari: disegnando "adesso" si vedrebbero scatti. Disegnando
 * 150 ms nel passato c'e' quasi sempre un pacchetto piu' recente verso cui
 * interpolare, al prezzo di un ritardo che a piedi non si nota.
 */
const LAG = 150

/** Colore stabile per identita': lo stesso peer ha sempre la stessa tinta. */
function hue(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return (h % 360) / 360
}

type Avatar = {
  root: THREE.Group
  mixer: THREE.AnimationMixer
  idle: THREE.AnimationAction | null
  walk: THREE.AnimationAction | null
  tag: THREE.Sprite
  tagCanvas: HTMLCanvasElement
  tagTex: THREE.CanvasTexture
  ring: THREE.Mesh
  lastName: string
  lastSpeaking: boolean
}

export class Peers {
  private avatars = new Map<string, Avatar>()
  private scene: THREE.Scene
  private template: THREE.Object3D
  private clips: THREE.AnimationClip[]
  private height: number

  constructor(scene: THREE.Scene, template: THREE.Object3D,
              clips: THREE.AnimationClip[], height: number) {
    this.scene = scene
    this.template = template
    this.clips = clips
    this.height = height
  }

  private make(p: Peer): Avatar {
    // SkeletonUtils.clone, non Object3D.clone: un modello con scheletro
    // condividerebbe le ossa e tutti gli avatar si muoverebbero insieme
    const model = cloneSkinned(this.template)
    // Ogni persona un colore: il modello e' lo stesso per tutti, quindi senza
    // questo si vedrebbero cloni identici. La tinta e' leggera (lerp 0.45) per
    // non trasformare la pelle in plastica colorata.
    const tint = new THREE.Color().setHSL(hue(p.id), 0.55, 0.55)
    model.traverse(o => {
      const m = (o as THREE.Mesh).material
      if (!m) return
      const mats = Array.isArray(m) ? m : [m]
      ;(o as THREE.Mesh).material = mats.map(src => {
        const c = (src as THREE.MeshStandardMaterial).clone()
        if (c.color) c.color.lerp(tint, 0.45)
        return c
      }) as unknown as THREE.Material
    })
    const root = new THREE.Group()
    root.add(model)

    const mixer = new THREE.AnimationMixer(model)
    const find = (n: string) => THREE.AnimationClip.findByName(this.clips, n)
    const ci = find('Idle_Loop'), cw = find('Walk_Loop')
    const idle = ci ? mixer.clipAction(ci) : null
    const walk = cw ? mixer.clipAction(cw) : null
    idle?.play()
    if (walk) { walk.enabled = true; walk.weight = 0; walk.play() }

    const tagCanvas = document.createElement('canvas')
    tagCanvas.width = 256; tagCanvas.height = 64
    const tagTex = new THREE.CanvasTexture(tagCanvas)
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tagTex, transparent: true, depthTest: false, depthWrite: false,
    }))
    tag.scale.set(1.1, 0.275, 1)
    tag.position.y = this.height + 0.34
    tag.renderOrder = 10
    root.add(tag)

    // anello a terra: si vede anche quando la targhetta e' fuori inquadratura
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.44, 24),
      new THREE.MeshBasicMaterial({
        color: 0xe0a458, transparent: true, opacity: 0, side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.02
    root.add(ring)

    this.scene.add(root)
    const a: Avatar = {
      root, mixer, idle, walk, tag, tagCanvas, tagTex, ring,
      lastName: '', lastSpeaking: false,
    }
    this.drawTag(a, p.name, false)
    return a
  }

  private drawTag(a: Avatar, name: string, speaking: boolean) {
    const c = a.tagCanvas.getContext('2d')!
    c.clearRect(0, 0, 256, 64)
    c.fillStyle = speaking ? 'rgba(224,164,88,0.22)' : 'rgba(0,0,0,0.42)'
    c.beginPath()
    c.roundRect(6, 12, 244, 40, 20)
    c.fill()
    c.strokeStyle = speaking ? '#e0a458' : 'rgba(255,255,255,0.16)'
    c.lineWidth = 2
    c.stroke()
    c.font = '600 24px ui-monospace, Consolas, monospace'
    c.fillStyle = speaking ? '#f3d6ac' : '#efe9e1'
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText(name.slice(0, 16), 128, 33)
    a.tagTex.needsUpdate = true
    a.lastName = name
    a.lastSpeaking = speaking
  }

  /** da chiamare ogni frame */
  update(net: Net, dt: number, camera: THREE.Camera) {
    const now = performance.now() - LAG
    for (const [id, p] of net.peers) {
      let a = this.avatars.get(id)
      if (!a) { a = this.make(p); this.avatars.set(id, a) }

      // interpolazione fra i due ultimi pacchetti, estrapolando al massimo
      // fino al piu' recente: mai oltre, o gli avatar "scivolano" via
      const span = Math.max(1, p.tTo - p.tFrom)
      const k = Math.min(1, Math.max(0, (now - p.tFrom) / span))
      a.root.position.set(
        p.from.x + (p.to.x - p.from.x) * k,
        p.from.y + (p.to.y - p.from.y) * k,
        p.from.z + (p.to.z - p.from.z) * k,
      )
      // angoli: interpola sul giro corto, altrimenti a cavallo di ±π gira al contrario
      let d = p.to.yaw - p.from.yaw
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      a.root.rotation.y = p.from.yaw + d * k

      const w = THREE.MathUtils.clamp(
        (a.walk?.weight ?? 0) + (p.to.w ? 1 : -1) * dt * 6, 0, 1)
      if (a.walk) a.walk.weight = w
      if (a.idle) a.idle.weight = 1 - w
      a.mixer.update(dt)

      const speaking = net.isSpeaking(p)
      if (speaking !== a.lastSpeaking || p.name !== a.lastName) {
        this.drawTag(a, p.name, speaking)
      }
      const m = a.ring.material as THREE.MeshBasicMaterial
      m.opacity += ((speaking ? 0.55 + Math.min(0.35, p.level * 3) : 0) - m.opacity)
        * Math.min(1, dt * 10)

      // la targhetta si rimpicciolisce con la distanza ma non sotto una
      // soglia leggibile, e sparisce quando e' troppo lontana per contare
      const d2 = a.root.position.distanceTo(camera.position)
      const s = THREE.MathUtils.clamp(d2 / 6, 0.75, 2.2)
      a.tag.scale.set(1.1 * s, 0.275 * s, 1)
      ;(a.tag.material as THREE.SpriteMaterial).opacity =
        d2 > 28 ? 0 : d2 > 20 ? (28 - d2) / 8 : 1
    }

    for (const [id, a] of this.avatars) {
      if (net.peers.has(id)) continue
      this.scene.remove(a.root)
      a.tagTex.dispose()
      this.avatars.delete(id)
    }
  }

  get count() { return this.avatars.size }
}
