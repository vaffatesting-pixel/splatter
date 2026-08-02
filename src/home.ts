// Home: map cards built from the same metrics the heightfields produced.
import { IS_TOUCH } from './mobile'

type MapCard = {
  id: string; label: string; sub: string
  area: number; walkable: number; slope: number
  mb: number
  mbLight: number          // the .splat build a phone downloads instead
  playable: boolean
  note?: string
}

const MAPS: MapCard[] = [
  { id: 'capitoline', label: 'Cortile Capitolino', sub: 'Roma', area: 491, walkable: 80.4, slope: 5.8, mb: 450, mbLight: 12, playable: true },
  { id: 'attic', label: 'Attico', sub: 'Interno', area: 96, walkable: 76.9, slope: 7.7, mb: 7, mbLight: 7, playable: true },
  { id: 'bonsai', label: 'Bonsai', sub: 'Studio', area: 751, walkable: 40.3, slope: 9.5, mb: 35, mbLight: 11, playable: true },
  { id: 'truck', label: 'Camion', sub: 'Esterno', area: 5738, walkable: 25.5, slope: 34.4, mb: 237, mbLight: 12, playable: true },
  { id: 'garden', label: 'Giardino', sub: 'Esterno', area: 2505, walkable: 24.7, slope: 9.9, mb: 12, mbLight: 12, playable: true },
  { id: 'train', label: 'Binari', sub: 'Esterno', area: 7171, walkable: 10.4, slope: 9.4, mb: 12, mbLight: 12, playable: true },
  // measured at 0.3 u of clearance against a 0.6 u character: it does not fit
  { id: 'playroom', label: 'Playroom', sub: 'Interno', area: 119, walkable: 48.7, slope: 23.0, mb: 53, mbLight: 53, playable: false, note: 'passaggi troppo stretti' },
]

// importing the flag (rather than re-testing here) keeps one definition of
// "this is a phone" — mobile.ts only runs code when its functions are called

/** Difficulty read off the metrics: open and flat is easy, broken and steep is not. */
function difficulty(m: MapCard) {
  const score = m.walkable - m.slope * 2
  return score > 65 ? 'FACILE' : score > 45 ? 'MEDIA' : score > 15 ? 'DIFFICILE' : 'ESTREMA'
}

const grid = document.getElementById('grid')!
for (const m of MAPS) {
  const card = document.createElement(m.playable ? 'a' : 'div')
  card.className = 'card' + (m.playable ? '' : ' off')
  if (m.playable) (card as HTMLAnchorElement).href = `/walk.html?map=${m.id}`
  card.innerHTML = `
    <span class="size">${IS_TOUCH ? m.mbLight : m.mb} MB</span>
    ${m.playable ? '' : `<span class="warnTag">${m.note ?? 'non giocabile'}</span>`}
    <img class="shot" src="/thumbs/${m.id}.jpg" alt="${m.label}" loading="lazy">
    <div class="body">
      <h3>${m.label}</h3>
      <span class="place">${m.sub}</span>
      <div class="meta">
        <div><span>Area</span><b>${m.area} m²</b></div>
        <div><span>Agibile</span><b>${m.walkable.toFixed(0)}%</b></div>
        <div><span>Difficoltà</span><b class="diff" data-d="${difficulty(m)}">${difficulty(m)}</b></div>
      </div>
    </div>`
  grid.appendChild(card)
}

// the controls list is written for a keyboard; on a phone it would be a lie
if (IS_TOUCH) {
  const list = document.querySelector('.controls ul')
  if (list) list.innerHTML = [
    ['Sinistra', 'joystick per muoversi'],
    ['A fondo', 'correre'],
    ['Destra', 'trascina per guardare'],
    ['E', 'raccogliere'],
    ['F', 'torcia'],
    ['R', 'batteria di scorta'],
  ].map(([k, v]) => `<li><b>${k}</b><span>${v}</span></li>`).join('')
  const tag = document.querySelector('.tag')
  if (tag) tag.textContent += ' · versione leggera per telefono'
}
