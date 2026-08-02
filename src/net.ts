// Presenza e voce di prossimita'. Nessun server: Trystero usa relay pubblici
// (Nostr per default) SOLO per farsi trovare, poi le connessioni sono WebRTC
// dirette fra i browser e i dati non passano piu' dal relay.
//
// Perche' Trystero e non le tre opzioni valutate:
//  - Playroom Kit NON ha voce (assente da API reference, docs e sito) e vuole
//    un gameId da un account
//  - WebRTC "a mano" vuole comunque un server di segnalazione nostro
//  - Colyseus vuole un processo Node sempre acceso: non gira su Vercel statico
// Trystero copre entrambe le cose (stato + stream audio), sta in una pagina
// statica e non chiede account. Mesh completa: giusta per 4-6 persone.
import { joinRoom, selfId } from 'trystero'
import type { Room } from 'trystero'

export const SELF_ID = selfId

/** Cosa ogni giocatore trasmette di se'. Volutamente minuscolo: va a 10 Hz. */
export type Move = {
  x: number; y: number; z: number
  yaw: number
  w: 0 | 1            // walking
}

export type Peer = {
  id: string
  name: string
  /** ultimo stato ricevuto e quello precedente: peers.ts interpola fra i due */
  from: Move; to: Move
  tFrom: number; tTo: number
  /** 0..1, riempito dall'analisi del suo stream: serve all'indicatore visivo */
  level: number
  hasVoice: boolean
}

export type NetOpts = {
  room: string
  /** mappa: stanze diverse per mappe diverse anche a parità di codice */
  map: string
  name: string
  audioCtx: () => AudioContext | null
  onJoin?: (p: Peer) => void
  onLeave?: (id: string) => void
}

const APP_ID = 'splatter-vaf'
// Relay Nostr scelti a mano. Con la lista di default capitava di finire su
// `strfry.openhoofd.nl` (timeout, ERR_SSL_UNRECOGNIZED_NAME_ALERT). Provato
// anche relay.damus.io: risponde 503 sotto carico, tolto. Ne bastano due
// raggiungibili perche' la stanza si formi.
const RELAYS = [
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://nostr.mom',
  'wss://relay.primal.net',
]
const SEND_HZ = 10
/** voce piena entro questo raggio */
const VOICE_NEAR = 3
/** silenzio oltre */
const VOICE_FAR = 14
const SPEAK_THRESHOLD = 0.055

type Voice = {
  el: HTMLAudioElement
  src: MediaStreamAudioSourceNode
  gain: GainNode
  panner: PannerNode
  analyser: AnalyserNode
  buf: Uint8Array<ArrayBuffer>
}

export class Net {
  readonly peers = new Map<string, Peer>()
  muted = true
  micReady = false
  micDenied = false
  /** livello del proprio microfono, per l'indicatore locale */
  selfLevel = 0

  private room: Room
  private opts: NetOpts
  private sendMove: (m: Move) => void
  private sendName: (n: string) => void
  /** puntatore condiviso: chi indica manda un punto, tutti lo vedono */
  sendPointer: (v: { x: number; y: number; z: number }) => void = () => {}
  onPointer: ((v: { x: number; y: number; z: number }, id: string) => void) | null = null
  /** riempita da walk.ts: true se quel peer e' nella nostra stessa zona */
  inSameZone: ((id: string) => boolean) | null = null
  private voices = new Map<string, Voice>()
  private micStream: MediaStream | null = null
  private micAnalyser: AnalyserNode | null = null
  private micBuf: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(32))
  private last = 0

  constructor(opts: NetOpts) {
    this.opts = opts
    // la mappa entra nell'id di stanza: lo stesso codice su mappe diverse
    // non deve mettere insieme gente che non puo' vedersi
    this.room = joinRoom(
      { appId: APP_ID, relayConfig: { urls: RELAYS, redundancy: 3 } },
      `${opts.map}:${opts.room}`,
    )

    // makeAction restituisce un oggetto {send, onMessage}, non una coppia
    const move = this.room.makeAction<Move>('mv')
    const name = this.room.makeAction<string>('nm')
    const ptr = this.room.makeAction<{ x: number; y: number; z: number }>('pt')
    this.sendPointer = v => { void ptr.send(v) }
    ptr.onMessage = (v, { peerId }) => this.onPointer?.(v, peerId)
    this.sendMove = m => { void move.send(m) }
    this.sendName = n => { void name.send(n) }

    move.onMessage = (m, { peerId }) => {
      const p = this.peers.get(peerId)
      if (!p) return
      p.from = p.to
      p.tFrom = p.tTo
      p.to = m
      p.tTo = performance.now()
    }
    name.onMessage = (n, { peerId }) => {
      const p = this.peers.get(peerId)
      if (p) p.name = String(n).slice(0, 16)
    }

    this.room.onPeerJoin = id => {
      const zero: Move = { x: 0, y: 0, z: 0, yaw: 0, w: 0 }
      const p: Peer = {
        id, name: '…', from: zero, to: zero,
        tFrom: performance.now(), tTo: performance.now(),
        level: 0, hasVoice: false,
      }
      this.peers.set(id, p)
      // chi arriva deve sapere subito chi c'e': ci ripresentiamo a ogni arrivo
      this.sendName(this.opts.name)
      if (this.micStream && !this.muted) this.room.addStream(this.micStream)
      opts.onJoin?.(p)
    }

    this.room.onPeerLeave = id => {
      this.dropVoice(id)
      this.peers.delete(id)
      opts.onLeave?.(id)
    }

    this.room.onPeerStream = (stream, id) => this.attachVoice(id, stream)
  }

  /** da chiamare ogni frame: manda la propria posizione a ritmo fisso */
  broadcast(m: Move) {
    const now = performance.now()
    if (now - this.last < 1000 / SEND_HZ) return
    this.last = now
    this.sendMove(m)
  }

  // ── voce ───────────────────────────────────────────────────────────────────

  /** Chiede il microfono. Va invocata da un gesto dell'utente (obbligatorio
   *  su iOS) e solo dopo aver spiegato perche', mai di sorpresa. */
  async enableMic(): Promise<boolean> {
    if (this.micReady) return true
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        },
      })
    } catch {
      this.micDenied = true
      return false
    }
    this.micReady = true
    this.muted = false
    this.room.addStream(this.micStream)

    const ctx = this.opts.audioCtx()
    if (ctx) {
      const a = ctx.createAnalyser()
      a.fftSize = 256
      ctx.createMediaStreamSource(this.micStream).connect(a)  // solo analisi
      this.micAnalyser = a
      this.micBuf = new Uint8Array(new ArrayBuffer(a.frequencyBinCount))
    }
    return true
  }

  setMuted(m: boolean) {
    this.muted = m
    for (const t of this.micStream?.getAudioTracks() ?? []) t.enabled = !m
  }

  private attachVoice(id: string, stream: MediaStream) {
    const ctx = this.opts.audioCtx()
    if (!ctx) return
    // GOTCHA: in Chrome uno stream WebRTC non produce audio dentro Web Audio se
    // non e' anche agganciato a un <audio> in riproduzione. L'elemento resta
    // muto — serve solo a "svegliare" lo stream — e il suono vero passa dal
    // grafo qui sotto, dove possiamo spazializzarlo.
    const el = new Audio()
    el.srcObject = stream
    el.muted = true
    el.autoplay = true
    el.play().catch(() => { /* riprovera' al primo gesto */ })

    const src = ctx.createMediaStreamSource(stream)
    const gain = ctx.createGain()
    gain.gain.value = 0
    const panner = ctx.createPanner()
    panner.panningModel = 'HRTF'
    // il panner fa SOLO la direzione: l'attenuazione con la distanza la
    // calcoliamo noi in update(), perche' i modelli del browser o non
    // arrivano mai a zero (inverse) o hanno spigoli netti (linear)
    panner.distanceModel = 'linear'
    panner.rolloffFactor = 0
    panner.refDistance = 1
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256

    src.connect(analyser)
    src.connect(gain).connect(panner).connect(ctx.destination)

    this.voices.set(id, {
      el, src, gain, panner, analyser,
      buf: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
    })
    const p = this.peers.get(id)
    if (p) p.hasVoice = true
  }

  private dropVoice(id: string) {
    const v = this.voices.get(id)
    if (!v) return
    try { v.src.disconnect(); v.gain.disconnect(); v.panner.disconnect() } catch { /* gia' chiuso */ }
    v.el.srcObject = null
    this.voices.delete(id)
  }

  /**
   * Posiziona ogni voce e ne calcola il volume dalla distanza.
   * Curva: 1 fino a VOICE_NEAR, smoothstep fino a VOICE_FAR, poi zero.
   * L'ascoltatore lo muove gia' GameAudio.setListener(), quindi qui bastano
   * le posizioni delle sorgenti.
   */
  update(lx: number, ly: number, lz: number) {
    const ctx = this.opts.audioCtx()
    for (const [id, v] of this.voices) {
      const p = this.peers.get(id)
      if (!p) continue
      const { x, y, z } = p.to
      if (v.panner.positionX) {
        v.panner.positionX.value = x
        v.panner.positionY.value = y
        v.panner.positionZ.value = z
      } else {
        v.panner.setPosition(x, y, z)
      }
      const d = Math.hypot(x - lx, y - ly, z - lz)
      const t = 1 - Math.min(1, Math.max(0, (d - VOICE_NEAR) / (VOICE_FAR - VOICE_NEAR)))
      // dentro una zona di conversazione la voce e' piena a prescindere dalla
      // distanza: e' il punto delle zone, sedersi in cerchio e sentirsi tutti
      const g = this.inSameZone?.(id) ? 1 : t * t * (3 - 2 * t)   // smoothstep
      if (ctx) v.gain.gain.setTargetAtTime(g, ctx.currentTime, 0.05)
      else v.gain.gain.value = g

      v.analyser.getByteTimeDomainData(v.buf)
      p.level = rms(v.buf) * (g > 0.02 ? 1 : 0)         // non "parla" se non lo senti
    }
    if (this.micAnalyser && !this.muted) {
      this.micAnalyser.getByteTimeDomainData(this.micBuf)
      this.selfLevel = rms(this.micBuf)
    } else this.selfLevel = 0
  }

  /** guadagno applicato alla voce di un peer: serve a misurare la curva */
  gainOf(id: string) {
    const v = this.voices.get(id)
    return v ? +v.gain.gain.value.toFixed(3) : null
  }

  isSpeaking(p: Peer) { return p.level > SPEAK_THRESHOLD }
  get selfSpeaking() { return this.selfLevel > SPEAK_THRESHOLD }

  leave() {
    for (const id of [...this.voices.keys()]) this.dropVoice(id)
    for (const t of this.micStream?.getTracks() ?? []) t.stop()
    this.room.leave()
  }
}

function rms(buf: Uint8Array<ArrayBuffer>) {
  let s = 0
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128
    s += v * v
  }
  return Math.sqrt(s / buf.length)
}

export { VOICE_NEAR, VOICE_FAR }
