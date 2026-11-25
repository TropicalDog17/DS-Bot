export const FLIGHT_ENDS = { tab: ':scope > .bt-ptabs .bt-ptab-bot .bt-mark', drawer: ':scope > .bt-panel-view .bt-drawer-id .bt-mark' }

export const flightEnd = next => (next === 'details' ? 'drawer' : 'tab')
export const flightStart = next => (next === 'details' ? 'tab' : 'drawer')

export const INTENT_MS = 1500
const SAFETY_MS = 400

export function planFlight(active, next) {
  if (active === null) return 'start'
  return active === flightEnd(next) ? 'keep' : 'reverse'
}

export function flightBox(from, to, p) {
  const mix = key => from[key] + (to[key] - from[key]) * p
  return { left: mix('left'), top: mix('top'), width: mix('width'), height: mix('height') }
}

const boxOf = rect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })

let serial = 0
/**
 * Give every id under `root` (and `root` itself) a name no other copy has, and point what
 * refers to it — `url(#id)` in any attribute, `href="#id"` — at the new name. An SVG
 * mask or gradient is found by id across the whole document, so a copy that keeps its ids
 * draws with whichever twin comes first, and draws nothing when that one is hidden.
 */
export function uniqueIds(root) {
  const suffix = `-f${++serial}`
  const renamed = new Map()
  for (const node of [root, ...root.querySelectorAll('[id]')]) {
    if (node.id === '') continue
    renamed.set(node.id, `${node.id}${suffix}`)
    node.id = renamed.get(node.id)
  }
  if (renamed.size === 0) return root
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const { name, value } of node.attributes) {
      let next = value.replace(/url\(\s*#([^)\s]+)\s*\)/g, (whole, id) => (renamed.has(id) ? `url(#${renamed.get(id)})` : whole))
      if ((name === 'href' || name === 'xlink:href') && next.startsWith('#') && renamed.has(next.slice(1))) next = `#${renamed.get(next.slice(1))}`
      if (next !== value) node.setAttribute(name, next)
    }
  }
  return root
}

export function createFlight(env) {
  const {
    shape,
    frame = run => requestAnimationFrame(run), unframe = id => cancelAnimationFrame(id),
    later = (run, ms) => setTimeout(run, ms), unlater = id => clearTimeout(id),
  } = env
  let live = null

  function finish() {
    if (live === null) return
    const { panel, node, step, safety } = live
    live = null
    if (step !== null) unframe(step)
    unlater(safety)
    node.remove()
    delete panel.dataset.flying
  }

  function place(now) {
    const { panel, node, end, from, size } = live
    live.step = null
    const target = panel.isConnected ? panel.querySelector(FLIGHT_ENDS[end]) : null
    const to = target?.getBoundingClientRect()
    if (to === undefined || to.width === 0) { finish(); return }
    if (live.at === null && now !== null) live.at = now
    const elapsed = live.at === null ? 0 : now - live.at
    const done = elapsed >= shape.duration
    const box = flightBox(from, boxOf(to), done ? 1 : shape.progress(elapsed))
    const edge = panel.getBoundingClientRect()
    const border = panel.ownerDocument.defaultView.getComputedStyle(panel)
    const x = box.left - edge.left - (parseFloat(border.borderLeftWidth) || 0)
    const y = box.top - edge.top - (parseFloat(border.borderTopWidth) || 0)
    node.style.transform = `translate(${x}px, ${y}px) scale(${box.width / size.width}, ${box.height / size.height})`
    if (done) finish()
    else live.step = frame(place)
  }

  const arm = () => later(finish, shape.duration + SAFETY_MS)

  return {
    active: () => live?.end ?? null,
    finish,
    begin({ panel, end, node, from }) {
      finish()
      if (!(from.width > 0 && from.height > 0)) return false
      node.classList.add('bt-mark-fly')
      Object.assign(node.style, { width: `${from.width}px`, height: `${from.height}px` })
      panel.append(node)
      panel.dataset.flying = end
      live = { panel, node, end, from: boxOf(from), size: { width: from.width, height: from.height }, at: null, step: null, safety: arm() }
      place(null)
      return true
    },
    retarget(end) {
      if (live === null) return false
      live.from = boxOf(live.node.getBoundingClientRect())
      live.end = end
      live.at = null
      live.panel.dataset.flying = end
      unlater(live.safety)
      live.safety = arm()
      return true
    },
  }
}
