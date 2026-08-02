// Il direttore: decide QUANDO succede qualcosa, e soprattutto quando non
// succede niente.
//
// Il buio continuo non fa paura, fa abitudine. Quello che spaventa e' il
// contrasto, quindi il valore vero di questo modulo sono i silenzi imposti:
// nessun evento prima di 60 secondi, mai due forti di fila, e 40 secondi di
// calma totale dopo ogni picco. La tensione sale da sola col tempo, con la
// batteria che cala e con gli obiettivi raccolti; scende di colpo dopo un
// evento, cosi' il ritmo respira invece di salire e basta.
//
// La minaccia non ha un corpo: esiste solo come suono posizionato. Non si vede
// mai niente, e non succede mai niente di concreto — e' l'attesa la meccanica.

export type DirectorState = {
  /** 0..1, quanto e' avanzata la partita */
  timeFraction: number
  battery: number
  collected: number
  targets: number
  /** posizione dell'ascoltatore, per mettere i suoni intorno */
  x: number; y: number; z: number
}

export type DirectorEvent = {
  kind: 'steps' | 'breath' | 'thud' | 'hush' | 'flicker'
  /** posizione del suono nel mondo */
  x: number; y: number; z: number
  /** quanto e' "forte" l'evento: i forti hanno le regole piu' severe */
  strong: boolean
}

/** Tutti i numeri in un posto solo, per poterli tarare senza cercarli. */
export const DIRECTOR = {
  firstEventAfter: 60,      // secondi prima che possa succedere qualcosa
  calmAfterPeak: 40,        // silenzio obbligatorio dopo un evento forte
  minGapStrong: 130,        // fra due eventi forti
  minGapAny: 22,            // fra due eventi qualsiasi
  tensionPerSecond: 0.055,  // salita di fondo
  tensionLowBattery: 22,    // quanto pesa la batteria scarica
  tensionPerObject: 7,      // ogni oggetto raccolto alza la posta
  dropAfterEvent: 34,       // quanto scende dopo un picco
  strongAbove: 62,          // sopra questa tensione gli eventi diventano forti
  finaleFrom: 0.2,          // ultimi 20% di tempo: si stringe
  nearMin: 6, nearMax: 14,  // distanza a cui nasce il suono
}

export class Director {
  tension = 0
  private t = 0
  private lastAny = -1e9
  private lastStrong = -1e9
  private calmUntil = 0
  /** solo per diagnostica: cosa e' successo e quando */
  log: { at: number; kind: string; strong: boolean }[] = []

  /** @returns un evento se e' il momento, altrimenti null */
  update(dt: number, s: DirectorState): DirectorEvent | null {
    this.t += dt

    // la tensione sale col tempo, con il buio che avanza e con la posta in gioco
    let target = this.t * DIRECTOR.tensionPerSecond
    target += (1 - s.battery) * DIRECTOR.tensionLowBattery
    target += s.collected * DIRECTOR.tensionPerObject
    if (s.timeFraction < DIRECTOR.finaleFrom) {
      // ultimo tratto: la corsa finale, la tensione non scende piu'
      target += (1 - s.timeFraction / DIRECTOR.finaleFrom) * 30
    }
    this.tension += (Math.min(100, target) - this.tension) * Math.min(1, dt * 0.5)

    if (this.t < DIRECTOR.firstEventAfter) return null
    if (this.t < this.calmUntil) return null
    if (this.t - this.lastAny < DIRECTOR.minGapAny) return null

    const strongOk = this.tension > DIRECTOR.strongAbove
      && this.t - this.lastStrong > DIRECTOR.minGapStrong
    // probabilita' bassa per frame: gli eventi devono sembrare capitare, non
    // arrivare a orario
    const chance = dt * (0.02 + this.tension / 100 * 0.05)
    if (Math.random() > chance) return null

    const strong = strongOk
    const kinds: DirectorEvent['kind'][] = strong
      ? ['steps', 'hush', 'flicker']
      : ['breath', 'thud', 'steps']
    const kind = kinds[Math.floor(Math.random() * kinds.length)]

    // il suono nasce a distanza media, in una direzione precisa: deve essere
    // localizzabile, altrimenti e' solo rumore
    const a = Math.random() * Math.PI * 2
    const d = DIRECTOR.nearMin + Math.random() * (DIRECTOR.nearMax - DIRECTOR.nearMin)
    const ev: DirectorEvent = {
      kind, strong,
      x: s.x + Math.cos(a) * d, y: s.y, z: s.z + Math.sin(a) * d,
    }

    this.lastAny = this.t
    if (strong) {
      this.lastStrong = this.t
      this.calmUntil = this.t + DIRECTOR.calmAfterPeak
      this.tension = Math.max(0, this.tension - DIRECTOR.dropAfterEvent)
    }
    this.log.push({ at: +this.t.toFixed(1), kind, strong })
    return ev
  }

  /** true mentre vale il silenzio imposto dopo un picco */
  get inCalm() { return this.t < this.calmUntil }
  get elapsed() { return this.t }
}
