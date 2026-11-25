export function sharedMap(key, storage = globalThis.localStorage) {
  const read = (fallback = {}) => {
    if (!storage) return fallback
    try {
      const value = JSON.parse(storage.getItem(key) ?? '{}')
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch {
      return fallback
    }
  }
  const update = (change, fallback = {}) => {
    const base = read(fallback)
    const next = change(base)
    if (next === base) return next
    try { storage?.setItem(key, JSON.stringify(next)) } catch {}
    return next
  }
  return { key, read, update }
}

export function setEntry(map, id, value) {
  if (value === undefined) {
    if (!Object.hasOwn(map, id)) return map
    const { [id]: _, ...rest } = map
    return rest
  }
  return { ...map, [id]: value }
}

export function toggleReaction(reactions, key, index, emoji) {
  const entry = { ...reactions[key] }
  const list = entry[index] ?? []
  entry[index] = list.includes(emoji) ? list.filter(item => item !== emoji) : [...list, emoji]
  if (entry[index].length === 0) delete entry[index]
  const next = { ...reactions }
  if (Object.keys(entry).length) next[key] = entry
  else delete next[key]
  return next
}

export function setUnread(unread, id, value) {
  if (Boolean(unread[id]) === value) return unread
  const next = { ...unread }
  if (value) next[id] = true
  else delete next[id]
  return next
}

export function noteLeft(seen, ids, now) {
  const next = { ...seen }
  for (const id of ids) next[id] = Math.max(Number(next[id]) || 0, now)
  return next
}
