// Touch layer: virtual stick, drag-to-look, action buttons, orientation hint.
//
// Two decisions worth stating. First, the action buttons do not call the game
// directly: they dispatch real KeyboardEvents, so E/F/R go through exactly the
// same handlers as the desktop keys — one code path, no second implementation
// to keep in sync. Second, nothing here touches PointerLockControls: on a phone
// there is no pointer to lock, so walk.ts drives the camera from yaw/pitch in
// first person too (see TOUCH_LOOK there).

/** Coarse pointer AND a real touchscreen: desktops with a touch monitor stay on mouse. */
export const IS_TOUCH =
  typeof matchMedia === 'function' &&
  matchMedia('(pointer: coarse)').matches &&
  (navigator.maxTouchPoints ?? 0) > 0

export type Stick = { x: number; y: number; run: boolean }

type Opts = {
  onLook: (dx: number, dy: number) => void
  /** so a tap can start the AudioContext and dismiss the intro, like a keypress */
  onTap?: () => void
}

const KEY = (code: string, type: 'keydown' | 'keyup') =>
  dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }))

export function setupTouch(opts: Opts): Stick {
  const stick: Stick = { x: 0, y: 0, run: false }
  if (!IS_TOUCH) return stick
  document.body.classList.add('touch')

  const pad = document.getElementById('stick') as HTMLElement | null
  const knob = document.getElementById('knob') as HTMLElement | null
  const RADIUS = 62               // px of travel for full speed

  let moveId = -1, lookId = -1
  let originX = 0, originY = 0, lastX = 0, lastY = 0

  const onDown = (e: PointerEvent) => {
    // target can be window (synthetic events) or a text node: guard before closest
    const t = e.target as HTMLElement | null
    if (t?.closest?.('#tbtns') || t?.closest?.('button')) return  // buttons handle themselves
    opts.onTap?.()
    if (e.clientX < innerWidth * 0.5 && moveId < 0) {
      moveId = e.pointerId
      originX = e.clientX; originY = e.clientY
      if (pad) {
        pad.style.left = `${originX}px`
        pad.style.top = `${originY}px`
        pad.classList.add('on')
      }
    } else if (lookId < 0) {
      lookId = e.pointerId
      lastX = e.clientX; lastY = e.clientY
    }
  }

  const onMove = (e: PointerEvent) => {
    if (e.pointerId === moveId) {
      let dx = e.clientX - originX, dy = e.clientY - originY
      const len = Math.hypot(dx, dy)
      if (len > RADIUS) { dx *= RADIUS / len; dy *= RADIUS / len }
      stick.x = dx / RADIUS
      stick.y = -dy / RADIUS               // screen y grows downward, forward is up
      stick.run = len > RADIUS * 0.85
      if (knob) knob.style.transform = `translate(${dx}px, ${dy}px)`
    } else if (e.pointerId === lookId) {
      opts.onLook(e.clientX - lastX, e.clientY - lastY)
      lastX = e.clientX; lastY = e.clientY
    }
  }

  const onUp = (e: PointerEvent) => {
    if (e.pointerId === moveId) {
      moveId = -1
      stick.x = stick.y = 0
      stick.run = false
      pad?.classList.remove('on')
      if (knob) knob.style.transform = 'translate(0,0)'
    } else if (e.pointerId === lookId) lookId = -1
  }

  addEventListener('pointerdown', onDown, { passive: true })
  addEventListener('pointermove', onMove, { passive: true })
  addEventListener('pointerup', onUp, { passive: true })
  addEventListener('pointercancel', onUp, { passive: true })

  for (const b of document.querySelectorAll<HTMLElement>('#tbtns [data-key]')) {
    const code = b.dataset.key!
    // pointerdown, not click: click waits ~300ms for a possible double tap
    b.addEventListener('pointerdown', ev => {
      ev.preventDefault()
      b.classList.add('down')
      opts.onTap?.()
      KEY(code, 'keydown')
      KEY(code, 'keyup')
    })
    const off = () => b.classList.remove('down')
    b.addEventListener('pointerup', off)
    b.addEventListener('pointercancel', off)
  }
  return stick
}

/** Nudge the player to turn the phone: the HUD works in portrait, but a horror
 *  game through a letterbox is not worth shipping. Dismissible, never blocking. */
export function setupOrientationHint() {
  if (!IS_TOUCH) return
  const el = document.getElementById('rotate')
  if (!el) return
  const check = () => {
    const portrait = innerHeight > innerWidth
    el.classList.toggle('on', portrait && !el.dataset.dismissed)
  }
  el.addEventListener('pointerdown', () => { el.dataset.dismissed = '1'; el.classList.remove('on') })
  addEventListener('resize', check)
  addEventListener('orientationchange', () => setTimeout(check, 250))
  check()
}
