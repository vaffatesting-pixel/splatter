// Game audio: sampled foley (Kenney RPG Audio, CC0) + a synthesised, reactive drone.
// Web Audio only, no libraries. Everything positional goes through an HRTF PannerNode.

const SAMPLES = {
  footstep: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => `/audio/footstep0${i}.ogg`),
  creak: ['/audio/creak1.ogg', '/audio/creak2.ogg', '/audio/creak3.ogg'],
  thud: ['/audio/dropLeather.ogg', '/audio/metalPot1.ogg', '/audio/metalPot2.ogg', '/audio/bookPlace1.ogg'],
  torchOn: ['/audio/metalClick.ogg'],
  torchOff: ['/audio/metalLatch.ogg'],
}

/** Everything tweakable, exposed on window.__audioParams at runtime. */
export const AUDIO_PARAMS = {
  // The synthesised drone was removed from the active path: at 46 Hz its layers
  // fell inside one critical band and produced constant audible roughness.
  // Dry foley (steps, creaks, clicks) reads better than a hum that never stops.
  enableDrone: false,
  enableBreath: false,   // same family of problem: a filtered-noise loop hisses
  master: 0.9,
  footstepVolume: 0.55,
  footstepStride: 0.85,     // metres of travel between steps
  footstepPitchJitter: 0.12,
  breathVolume: 0.11,      // deliberately subtle: it sits right at the ear
  breathRate: 0.26,         // breaths per second at rest
  breathRateRunning: 0.55,
  droneVolume: 0.3,
  droneBaseHz: 46,          // fundamental when everything is calm
  droneDeadHz: 32,          // fundamental with the torch dead
  droneCutoffCalm: 320,
  droneCutoffTense: 1400,   // final minute
  droneDensityCalm: 0.25,   // noise layer level
  droneDensityDead: 0.75,
  tensionHarmonic: 4,       // tension note = fundamental x this (stays consonant)
  creakVolume: 0.5,
  creakMinGap: 7,           // seconds
  creakMaxGap: 22,
  creakRadius: 9,           // how far around the player creaks are placed
  thudVolume: 0.6,
  torchClickVolume: 0.7,
}

export type AudioState = {
  battery: number       // 1 = full, 0 = dead
  torchOn: boolean
  timeFraction: number  // 1 = full timer left, 0 = out of time
  allCollected: boolean
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T>(arr: T[]) => arr[(Math.random() * arr.length) | 0]

export class GameAudio {
  ctx: AudioContext | null = null
  private master!: GainNode
  private buffers = new Map<string, AudioBuffer>()
  private ready = false

  // drone graph
  private droneOsc!: OscillatorNode
  private droneOsc2!: OscillatorNode
  private droneFilter!: BiquadFilterNode
  private droneGain!: GainNode
  private noiseGain!: GainNode
  private tensionOsc!: OscillatorNode
  private tensionGain!: GainNode

  // breathing
  private breathGain!: GainNode
  private breathFilter!: BiquadFilterNode
  private breathPhase = 0

  private strideAccum = 0
  private nextCreak = 0
  private clock = 0

  private analyser: AnalyserNode | null = null

  /** Peak/RMS of the master bus, to catch clipping and amplitude modulation. */
  measure(ms = 1200): Promise<{ peak: number; rms: number; clipped: boolean; modulation: number }> {
    const ctx = this.ctx!
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser()
      this.analyser.fftSize = 2048
      this.master.connect(this.analyser)
    }
    const an = this.analyser
    const buf = new Float32Array(an.fftSize)
    const peaks: number[] = []
    return new Promise(resolve => {
      const t0 = performance.now()
      const tick = () => {
        an.getFloatTimeDomainData(buf)
        let peak = 0, sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = Math.abs(buf[i])
          if (v > peak) peak = v
          sum += buf[i] * buf[i]
        }
        peaks.push(peak)
        if (performance.now() - t0 < ms) requestAnimationFrame(tick)
        else {
          const maxPeak = Math.max(...peaks)
          const minPeak = Math.min(...peaks)
          const mean = peaks.reduce((a, b) => a + b, 0) / peaks.length
          resolve({
            peak: +maxPeak.toFixed(3),
            rms: +Math.sqrt(sum / buf.length).toFixed(3),
            clipped: maxPeak >= 0.999,
            // how much the level swings between frames: high = audible tremolo
            modulation: +((maxPeak - minPeak) / (mean || 1)).toFixed(2),
          })
        }
      }
      tick()
    })
  }

  /** Mute individual layers to isolate a problem. */
  solo(opts: { drone?: boolean; breath?: boolean; tension?: boolean; noise?: boolean }) {
    if (opts.drone !== undefined && this.droneGain) this.droneGain.gain.value = opts.drone ? AUDIO_PARAMS.droneVolume : 0
    if (opts.breath !== undefined && this.breathGain) this.breathGain.gain.value = opts.breath ? AUDIO_PARAMS.breathVolume : 0
    if (opts.tension !== undefined && this.tensionGain) this.tensionGain.gain.value = opts.tension ? 0.1 : 0
    if (opts.noise !== undefined && this.noiseGain) this.noiseGain.gain.value = opts.noise ? AUDIO_PARAMS.droneDensityCalm : 0
  }

  /** Counters + live drone values, so the audio can be verified without ears. */
  stats = { footsteps: 0, creaks: 0, thuds: 0, clicks: 0, loaded: 0, panners: 0 }
  probe() {
    return {
      ...this.stats,
      state: this.ctx?.state ?? 'none',
      droneHz: +(this.droneOsc?.frequency.value ?? 0).toFixed(1),
      cutoff: +(this.droneFilter?.frequency.value ?? 0).toFixed(0),
      density: +(this.noiseGain?.gain.value ?? 0).toFixed(3),
      tension: +(this.tensionGain?.gain.value ?? 0).toFixed(3),
      tensionHz: +(this.tensionOsc?.frequency.value ?? 0).toFixed(1),
      breath: +(this.breathGain?.gain.value ?? 0).toFixed(4),
    }
  }

  /** Must be called from a user gesture (or with autoplay disabled). */
  async init() {
    if (this.ctx) return
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = AUDIO_PARAMS.master
    this.master.connect(ctx.destination)

    if (ctx.listener.forwardX) {
      ctx.listener.forwardY.value = 0
      ctx.listener.upY.value = 1
    }

    if (AUDIO_PARAMS.enableDrone) this.buildDrone()
    if (AUDIO_PARAMS.enableBreath) this.buildBreath()
    await this.loadAll()
    this.ready = true
    this.nextCreak = rnd(AUDIO_PARAMS.creakMinGap, AUDIO_PARAMS.creakMaxGap)
  }

  private async loadAll() {
    const ctx = this.ctx!
    const urls = Object.values(SAMPLES).flat()
    await Promise.all(urls.map(async url => {
      try {
        const res = await fetch(url)
        const buf = await ctx.decodeAudioData(await res.arrayBuffer())
        this.buffers.set(url, buf)
        this.stats.loaded++
      } catch { /* a missing sample must not break the game */ }
    }))
  }

  // ── synthesised layers ─────────────────────────────────────────────────────
  private buildDrone() {
    const ctx = this.ctx!
    const p = AUDIO_PARAMS

    this.droneFilter = ctx.createBiquadFilter()
    this.droneFilter.type = 'lowpass'
    this.droneFilter.frequency.value = p.droneCutoffCalm
    // Q was 3: a resonant peak on a 46 Hz saw rings and adds to the roughness
    this.droneFilter.Q.value = 0.7

    this.droneGain = ctx.createGain()
    this.droneGain.gain.value = p.droneVolume
    this.droneFilter.connect(this.droneGain).connect(this.master)

    this.droneOsc = ctx.createOscillator()
    this.droneOsc.type = 'sawtooth'
    this.droneOsc.frequency.value = p.droneBaseHz
    this.droneOsc.connect(this.droneFilter)
    this.droneOsc.start()

    // An OCTAVE above, not a fifth. Below ~100 Hz a fifth (46 vs 69 Hz) falls
    // inside one critical band and is heard as roughness, not as harmony.
    this.droneOsc2 = ctx.createOscillator()
    this.droneOsc2.type = 'sine'
    this.droneOsc2.frequency.value = p.droneBaseHz * 2
    const g2 = ctx.createGain()
    g2.gain.value = 0.5
    this.droneOsc2.connect(g2).connect(this.droneFilter)
    this.droneOsc2.start()

    // noise bed: "density" of the drone
    const noise = ctx.createBufferSource()
    noise.buffer = this.makeNoise(4)
    noise.loop = true
    this.noiseGain = ctx.createGain()
    this.noiseGain.gain.value = p.droneDensityCalm
    const nf = ctx.createBiquadFilter()
    nf.type = 'lowpass'
    nf.frequency.value = 500
    noise.connect(nf).connect(this.noiseGain).connect(this.droneGain)
    noise.start()

    // tension note, silent until the last minute
    this.tensionOsc = ctx.createOscillator()
    this.tensionOsc.type = 'triangle'
    this.tensionOsc.frequency.value = p.droneBaseHz * p.tensionHarmonic
    this.tensionGain = ctx.createGain()
    this.tensionGain.gain.value = 0
    this.tensionOsc.connect(this.tensionGain).connect(this.master)
    this.tensionOsc.start()
  }

  private buildBreath() {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.makeNoise(3)
    src.loop = true
    this.breathFilter = ctx.createBiquadFilter()
    this.breathFilter.type = 'bandpass'
    this.breathFilter.frequency.value = 620
    this.breathFilter.Q.value = 1.1
    this.breathGain = ctx.createGain()
    this.breathGain.gain.value = 0
    src.connect(this.breathFilter).connect(this.breathGain).connect(this.master)
    src.start()
  }

  private makeNoise(seconds: number) {
    const ctx = this.ctx!
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate)
    const d = buf.getChannelData(0)
    let last = 0
    let peak = 0
    for (let i = 0; i < d.length; i++) {
      // pink-ish: a one-pole filter on white noise, cheaper than a full pink filter
      const white = Math.random() * 2 - 1
      last = (last + 0.02 * white) / 1.02
      d[i] = last
      const a = Math.abs(last)
      if (a > peak) peak = a
    }
    // normalise instead of scaling by a guessed constant: the one-pole's output
    // level depends on the seed, so a fixed multiplier gives unpredictable peaks
    const norm = peak > 0 ? 0.9 / peak : 1
    for (let i = 0; i < d.length; i++) d[i] *= norm
    return buf
  }

  // ── positional one-shots ───────────────────────────────────────────────────
  private playAt(url: string, x: number, y: number, z: number, volume: number, rate = 1) {
    if (!this.ready || !this.ctx) return
    const buf = this.buffers.get(url)
    if (!buf) return
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = ctx.createGain()
    g.gain.value = volume
    const pan = ctx.createPanner()
    pan.panningModel = 'HRTF'
    pan.distanceModel = 'inverse'
    pan.refDistance = 1.4
    pan.maxDistance = 40
    pan.rolloffFactor = 1.2
    if (pan.positionX) {
      pan.positionX.value = x; pan.positionY.value = y; pan.positionZ.value = z
    } else pan.setPosition(x, y, z)
    src.connect(g).connect(pan).connect(this.master)
    src.start()
    this.stats.panners++
  }

  footstep(x: number, y: number, z: number, running: boolean) {
    this.stats.footsteps++
    const rate = 1 + rnd(-1, 1) * AUDIO_PARAMS.footstepPitchJitter + (running ? 0.08 : 0)
    this.playAt(pick(SAMPLES.footstep), x, y, z, AUDIO_PARAMS.footstepVolume * (running ? 1.25 : 1), rate)
  }

  thud(x: number, y: number, z: number) {
    this.stats.thuds++
    this.playAt(pick(SAMPLES.thud), x, y, z, AUDIO_PARAMS.thudVolume, rnd(0.9, 1.1))
  }

  torchClick(on: boolean) {
    this.stats.clicks++
    const src = on ? SAMPLES.torchOn : SAMPLES.torchOff
    // right at the listener: no panning needed, but keep the same path
    this.playAt(pick(src), 0, 0, 0, AUDIO_PARAMS.torchClickVolume)
  }

  /** Move the listener. dir must be normalised. */
  setListener(px: number, py: number, pz: number, dx: number, dy: number, dz: number) {
    const l = this.ctx?.listener
    if (!l) return
    if (l.positionX) {
      l.positionX.value = px; l.positionY.value = py; l.positionZ.value = pz
      l.forwardX.value = dx; l.forwardY.value = dy; l.forwardZ.value = dz
    } else {
      l.setPosition(px, py, pz)
      l.setOrientation(dx, dy, dz, 0, 1, 0)
    }
  }

  /**
   * @param speed  actual horizontal speed in units/second — steps are driven by
   *               distance travelled, so they stay in sync at any frame rate.
   */
  update(dt: number, state: AudioState, pos: { x: number; y: number; z: number }, speed: number, running: boolean) {
    if (!this.ready || !this.ctx) return
    const p = AUDIO_PARAMS
    const t = this.ctx.currentTime
    this.clock += dt

    // footsteps: one every `stride` metres actually covered
    if (speed > 0.15) {
      this.strideAccum += speed * dt
      const stride = p.footstepStride * (running ? 1.25 : 1)
      if (this.strideAccum >= stride) {
        this.strideAccum -= stride
        this.footstep(pos.x, pos.y - 0.8, pos.z, running)
      }
    } else this.strideAccum = Math.min(this.strideAccum, p.footstepStride * 0.6)

    // breathing: faster and louder when running or when the battery is low
    if (this.breathGain) {
    const stress = (running ? 1 : 0) * 0.6 + (1 - state.battery) * 0.4
    const rate = p.breathRate + (p.breathRateRunning - p.breathRate) * stress
    this.breathPhase += dt * rate
    const cycle = this.breathPhase % 1
    // inhale on the first 40%, exhale after: asymmetric envelope reads as breath
    const env = cycle < 0.4
      ? Math.sin((cycle / 0.4) * Math.PI) * 1.0
      : Math.sin(((cycle - 0.4) / 0.6) * Math.PI) * 0.7
    // tau 0.05 was shorter than a frame at 15-25 FPS, so the gain moved in steps
    this.breathGain.gain.setTargetAtTime(env * p.breathVolume * (0.7 + stress * 0.6), t, 0.14)
    this.breathFilter.frequency.setTargetAtTime(cycle < 0.4 ? 780 : 520, t, 0.25)
    }

    // ── reactive drone (only if enabled) ─────────────────────────────────────
    if (!this.droneOsc) { this.updateCreaks(dt, state, pos); return }
    const dead = 1 - state.battery                       // 0 fresh, 1 empty
    const dark = state.torchOn ? 0 : 1
    const endgame = 1 - Math.min(1, state.timeFraction / 0.2)  // last 20% of the timer
    const urgency = state.allCollected ? 1 : 0

    // pitch sags as the battery drains and when the torch is off
    const base = p.droneBaseHz + (p.droneDeadHz - p.droneBaseHz) * Math.max(dead, dark * 0.8)
    this.droneOsc.frequency.setTargetAtTime(base, t, 0.6)
    this.droneOsc2.frequency.setTargetAtTime(base * 2, t, 0.6)

    // cutoff: dark and closed normally, opening up in the final minute
    const cutoff = p.droneCutoffCalm
      + (p.droneCutoffTense - p.droneCutoffCalm) * Math.max(endgame, urgency * 0.55)
      - dark * 160
    this.droneFilter.frequency.setTargetAtTime(Math.max(60, cutoff), t, 0.8)

    // density: thicker as the battery dies
    const density = p.droneDensityCalm
      + (p.droneDensityDead - p.droneDensityCalm) * Math.max(dead, dark * 0.9)
    this.noiseGain.gain.setTargetAtTime(density, t, 1.0)

    // the tension note fades in for the endgame, and shifts up once you can leave
    this.tensionGain.gain.setTargetAtTime(0.1 * Math.max(endgame, urgency * 0.7), t, 1.2)
    this.tensionOsc.frequency.setTargetAtTime(base * p.tensionHarmonic * (urgency ? 1.5 : 1), t, 1.5)

    this.updateCreaks(dt, state, pos)
  }

  private updateCreaks(dt: number, state: AudioState, pos: { x: number; y: number; z: number }) {
    const p = AUDIO_PARAMS
    const dark = state.torchOn ? 0 : 1
    // ── random creaks around the player ──────────────────────────────────────
    this.nextCreak -= dt
    if (this.nextCreak <= 0) {
      const a = Math.random() * Math.PI * 2
      const r = rnd(p.creakRadius * 0.35, p.creakRadius)
      this.stats.creaks++
      this.playAt(pick(SAMPLES.creak),
        pos.x + Math.cos(a) * r, pos.y + rnd(-0.5, 2.2), pos.z + Math.sin(a) * r,
        p.creakVolume * rnd(0.6, 1), rnd(0.75, 1.15))
      // irregular on purpose: a metronome of creaks stops being unsettling
      this.nextCreak = rnd(p.creakMinGap, p.creakMaxGap) * (dark ? 0.65 : 1)
    }
  }
}
