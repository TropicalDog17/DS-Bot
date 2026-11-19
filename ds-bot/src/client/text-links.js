import { createSource } from './sources.js'

// Links a companion puts into a Bot's text (the Board's card tags). Each entry is
// { origin, page?, link(text), open(id), subscribe? }:
// - `link` turns the pieces it owns into markdown links under `origin`;
// - a tap on such a link calls `open` with the rest of its href, then opens `page`;
// - `subscribe` says when `link` would now write something else, so the bubbles redraw.
// A bubble reads them wherever it is drawn, so they live here and not in the app's state.
const entries = createSource(Object.freeze([]))

export const textLinks = {
  subscribe: entries.subscribe,
  getSnapshot: entries.getSnapshot,
  add(entry) {
    entries.set(list => Object.freeze([...list, entry]))
    const off = entry.subscribe?.(() => entries.set(list => Object.freeze([...list])))
    return () => {
      off?.()
      entries.set(list => Object.freeze(list.filter(item => item !== entry)))
    }
  },
}

export const linkTexts = (text, links) => links.reduce((out, entry) => entry.link(out), text)

// The link a tap landed on: { entry, id }, or null.
export function linkTarget(event, links) {
  if (links.length === 0 || typeof event.target?.closest !== 'function') return null
  for (const entry of links) {
    const anchor = event.target.closest(`a[href^="${entry.origin}"]`)
    if (anchor) return { entry, id: anchor.getAttribute('href').slice(entry.origin.length) }
  }
  return null
}
