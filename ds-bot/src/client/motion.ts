import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'

export const effectsTier = () => {
  const tier = typeof document === 'undefined' ? undefined : (document.body?.dataset?.btEffects || document.documentElement?.dataset?.btEffects)
  return tier === 'reduced' || tier === 'off' ? tier : 'full'
}
export const reducedMotion = () => effectsTier() === 'off' || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true)
export const reducedEffects = () => effectsTier() !== 'full' || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true)
export const noHover = () => window.matchMedia?.('(hover: none)').matches === true

// The bottom edge of what the user can see: window.innerHeight, or the visible
// region the visual viewport reports while the on-screen keyboard is open —
// innerHeight does not shrink for it.
export const viewBottom = () => (window.visualViewport ? window.visualViewport.height + window.visualViewport.offsetTop : window.innerHeight)

export function useViewport() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return undefined
    const bump = () => setTick(value => value + 1)
    viewport.addEventListener('resize', bump)
    viewport.addEventListener('scroll', bump)
    return () => { viewport.removeEventListener('resize', bump); viewport.removeEventListener('scroll', bump) }
  }, [])
  return tick
}

export function springEasing(stiffness, damping) {
  const w0 = Math.sqrt(stiffness)
  const zeta = damping / (2 * w0)
  const at = (t) => {
    if (zeta >= 1) return 1 - (1 + w0 * t) * Math.exp(-w0 * t)
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t))
  }
  let end = 0.05
  while (end < 2 && Math.abs(1 - at(end)) > 0.001) end += 0.01
  const points = Array.from({ length: 25 }, (_, index) => (index === 24 ? 1 : at(end * index / 24)).toFixed(4))
  const duration = Math.round(end * 1000)
  const progress = ms => (ms >= duration ? 1 : ms <= 0 ? 0 : at(ms / 1000))
  return { duration, easing: `linear(${points.join(',')})`, stiffness, damping, progress }
}

export const SPRING_SHAPE = springEasing(400, 31.2)
export const SPRING_TAP = springEasing(900, 48)
export const SPRING_LIST = springEasing(484, 35.2)
export const SPRING_STRETCH = springEasing(320, 20)
export const SPRING_POP = springEasing(500, 22)
export const SPRING_LEAD = springEasing(784, 48.2)
export const SPRING_TRAIL = springEasing(289, 29.2)
export const SPRING_GLIDE = springEasing(1000, 63)
export const QUICK_EDGES = { lead: springEasing(900, 51), trail: springEasing(400, 34) }

export const spring = (curve, ...properties) => properties.map(property => `${property} ${curve.duration}ms ${curve.easing}`).join(',')

function liveSprings(apply) {
  const values = new Map()
  const current = {}
  let frame = 0
  let last = 0
  const step = (now) => {
    const dt = Math.min(0.5, Math.max(0.001, (now - last) / 1000))
    last = now
    const steps = Math.ceil(dt * 240)
    const h = dt / steps
    let moving = false
    for (const [key, value] of values) {
      for (let index = 0; index < steps; index += 1) {
        value.v += (-value.k * (value.x - value.to) - value.c * value.v) * h
        value.x += value.v * h
      }
      if (Math.abs(value.x - value.to) < 0.05 && Math.abs(value.v) < 1) { value.x = value.to; value.v = 0 } else moving = true
      current[key] = value.x
    }
    apply(current)
    frame = moving ? requestAnimationFrame(step) : 0
  }
  return {
    target: () => {
      if (!values.size) return null
      const out = {}
      for (const [key, value] of values) out[key] = value.to
      return out
    },
    set(targets, curves, jump) {
      for (const [key, to] of Object.entries(targets)) {
        const value = values.get(key)
        const { stiffness: k, damping: c } = curves[key]
        if (!value || jump) { values.set(key, { x: to, v: 0, to, k, c }); current[key] = to }
        else Object.assign(value, { to, k, c })
      }
      if (jump) { cancelAnimationFrame(frame); frame = 0; apply(current); return }
      if (!frame) { last = performance.now(); frame = requestAnimationFrame(step) }
    },
    stop: () => cancelAnimationFrame(frame),
  }
}

const CHOSEN = '[aria-pressed="true"],[aria-selected="true"],[aria-current="page"]'

export function useGlide(key, { axis = 'x', selector = CHOSEN, lead = SPRING_LEAD, trail = SPRING_TRAIL, box: given }: Record<string, any> = {}) {
  const ownBox = useRef(null)
  const box = given ?? ownBox
  const thumb = useRef(null)
  const own = useRef(null)
  if (own.current === null) {
    own.current = {
      key: undefined, node: null, observer: null,
      springs: liveSprings(({ start, end }) => {
        const knob = thumb.current
        if (!knob) return
        knob.style.transform = axis === 'x' ? `translateX(${start}px)` : `translateY(${start}px)`
        knob.style[axis === 'x' ? 'width' : 'height'] = `${Math.max(0, end - start)}px`
      }),
    }
  }
  const place = (jump) => {
    const container = box.current
    const knob = thumb.current
    if (!container || !knob) return
    const chosen = container.querySelector(selector)
    if (!chosen) { knob.dataset.hidden = ''; return }
    const start = axis === 'x' ? chosen.offsetLeft : chosen.offsetTop
    const end = start + (axis === 'x' ? chosen.offsetWidth : chosen.offsetHeight)
    const { springs } = own.current
    const before = springs.target()
    const hidden = knob.dataset.hidden !== undefined
    if (jump && !hidden && before?.start === start && before?.end === end && container.dataset.glide !== undefined) return
    delete knob.dataset.hidden
    const forward = before === null || start >= before.start
    springs.set({ start, end }, forward ? { start: trail, end: lead } : { start: lead, end: trail }, jump || hidden || before === null || reducedMotion())
    container.dataset.glide = ''
  }
  useLayoutEffect(() => {
    const state = own.current
    const node = box.current
    if (node === state.node && key === state.key) return
    const fresh = node !== state.node
    state.key = key
    if (fresh) {
      state.observer?.disconnect()
      state.node = node
      state.observer = node && typeof ResizeObserver === 'function' ? new ResizeObserver(() => place(true)) : null
      state.observer?.observe(node)
    }
    place(fresh)
  })
  useEffect(() => () => { own.current.observer?.disconnect(); own.current.springs.stop() }, [])
  return { box, thumb }
}

export function Segmented({ label, value, className, children }) {
  const glide = useGlide(value)
  return h('div', { ref: glide.box, className: className ? `bt-seg ${className}` : 'bt-seg', role: 'group', 'aria-label': label },
    h('span', { ref: glide.thumb, className: 'bt-thumb', 'aria-hidden': true }), children)
}

export function useFlip(list, key, selector, id = node => node.dataset.flip) {
  const tops = useRef(null)
  useLayoutEffect(() => {
    const container = list.current
    if (!container) return
    const next = new Map()
    const moving = tops.current !== null && !reducedMotion()
    for (const node of container.querySelectorAll(selector)) {
      const name = id(node)
      const top = node.offsetTop
      next.set(name, top)
      if (!moving) continue
      const before = tops.current.get(name)
      if (before === undefined) {
        const noBlur = reducedEffects()
        node.animate([noBlur ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)' }, noBlur ? { opacity: 1 } : { opacity: 1, filter: 'blur(0)' }], { duration: 180, easing: 'ease-out' })
      } else if (Math.abs(before - top) > 0.5) {
        node.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], { duration: SPRING_LIST.duration, easing: SPRING_LIST.easing })
      }
    }
    tops.current = next
  }, [key])
}

export function useMorph(box, key) {
  const last = useRef({ key, height: null, node: null, observer: null })
  useLayoutEffect(() => {
    const node = box.current
    const state = last.current
    if (node !== state.node) {
      state.observer?.disconnect()
      Object.assign(state, { key, height: null, node, observer: null })
      if (!node || typeof ResizeObserver !== 'function') return
      state.observer = new ResizeObserver(([entry]) => {
        if (node.dataset.morph === undefined) state.height = entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight
      })
      state.observer.observe(node)
      return
    }
    if (!node || key === state.key) return
    const running = node.getAnimations().filter(animation => animation.id === 'bt-morph')
    const from = running.length ? node.offsetHeight : state.height
    for (const animation of running) animation.cancel()
    const to = node.offsetHeight
    Object.assign(state, { key, height: to })
    if (from === null || Math.abs(from - to) < 1 || reducedEffects()) return
    node.dataset.morph = ''
    const animation = node.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: SPRING_SHAPE.duration, easing: SPRING_SHAPE.easing, id: 'bt-morph' })
    animation.onfinish = () => { delete node.dataset.morph }
    animation.oncancel = () => { if (!node.getAnimations().some(other => other.id === 'bt-morph' && other !== animation)) delete node.dataset.morph }
  })
  useEffect(() => () => last.current.observer?.disconnect(), [])
}

export function useLinger(value, ms) {
  const [kept, setKept] = useState(value)
  useEffect(() => {
    if (value) { setKept(value); return undefined }
    const timer = setTimeout(() => setKept(value), reducedMotion() ? 0 : ms)
    return () => clearTimeout(timer)
  }, [value])
  return [value || kept, !value && Boolean(kept)]
}

export function stepMenuFocus(menu, event, trigger) {
  if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false
  const items = Array.from(menu.querySelectorAll('button[role^="menuitem"]:not(:disabled)')) as HTMLElement[]
  if (items.length === 0) return false
  const target = document.activeElement
  const current = items.indexOf(target as HTMLElement)
  if (current === -1 && target !== menu && target !== trigger) return false
  event.preventDefault()
  event.stopPropagation()
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % items.length
        : (current <= 0 ? items.length - 1 : current - 1)
  items[next]?.focus()
  return true
}
