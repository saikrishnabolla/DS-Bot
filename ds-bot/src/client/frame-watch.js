// The panel writes the Cue conversation column's right margin without
// restyling the whole page.
import { installStyles } from './styles.js'

const SELECTOR = '[data-cue-main]'
const room = { rule: null }
const roomRule = () => {
  if (room.rule?.parentStyleSheet?.ownerNode?.isConnected) return room.rule
  const declarations = room.rule?.style.cssText ?? ''
  room.rule?.parentStyleSheet?.ownerNode?.remove()
  const style = installStyles(`${SELECTOR}{${declarations}}`, 'chat-room')
  room.rule = style.sheet.cssRules[0]
  return room.rule
}
const margin = (side, width, style) => {
  if (width === null) style.removeProperty(`margin-${side}`)
  else style.setProperty(`margin-${side}`, `${width}px`, 'important')
}
let roomHold = 0
export const chatRoom = {
  /** The margin the Bot panel takes on the right, in px, or null when closed. */
  setRight(width) { margin('right', width, roomRule().style) },
  /** While on, a margin change lands at once instead of gliding. */
  hold(on) {
    cancelAnimationFrame(roomHold)
    if (on) { roomRule().style.setProperty('transition', 'none', 'important'); return }
    // Two frames, so the last held write is on screen before the glide comes back.
    roomHold = requestAnimationFrame(() => { roomHold = requestAnimationFrame(() => roomRule().style.removeProperty('transition')) })
  },
  /** The columns themselves, for a drag's per-frame writes. */
  columns() {
    roomRule()
    return [...document.querySelectorAll(SELECTOR)]
  },
}
