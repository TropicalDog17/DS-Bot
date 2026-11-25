import { STORAGE } from './storage.ts'

export function groupsFor({ mode, plain = false }) {
  return { shell: mode === 'bot', conversation: mode === 'bot' && !plain }
}

const GROUPS = ['shell', 'conversation']

function disposeAll(disposers, label) {
  for (const dispose of [...disposers].reverse()) {
    try { dispose?.() } catch (error) { console.warn(`[ds-bot] ${label}`, error) }
  }
}

export function surfaceGroups(install, { onError }: { onError?: (group: any, error: any) => void } = {}) {
  const mounted = { shell: [], conversation: [] }
  const withdraw = (group) => {
    const disposers = mounted[group]
    mounted[group] = []
    disposeAll(disposers, `withdraw ${group}`)
  }
  const mount = (group) => {
    const disposers = []
    try {
      for (const step of install[group]()) if (step) disposers.push(step())
      mounted[group] = disposers
      return true
    } catch (error) {
      disposeAll(disposers, `roll back ${group}`)
      console.warn(`[ds-bot] install ${group}`, error)
      onError?.(group, error)
      return false
    }
  }
  let lastWanted = {}
  const api = {
    reconcile(wanted) {
      lastWanted = wanted
      for (const group of [...GROUPS].reverse()) if (!wanted[group]) withdraw(group)
      for (const group of GROUPS) {
        if (!wanted[group] || mounted[group].length > 0) continue
        if (!mount(group)) break
      }
    },
    remount(group, wanted = lastWanted) {
      if (!GROUPS.includes(group)) return
      for (const later of GROUPS.slice(GROUPS.indexOf(group) + 1)) withdraw(later)
      withdraw(group)
      api.reconcile(wanted)
    },
    dispose() { for (const group of [...GROUPS].reverse()) withdraw(group) },
  }
  return api
}

export function freePriority(entries, { priority, key, id }: { priority?: any; key?: any; id?: any }) {
  if (priority === undefined) return undefined
  const taken = entries
    .filter(entry => (key === undefined || entry.options?.key === key) && (id === undefined || entry.options?.id === id))
    .map(entry => (entry.options?.priority ?? 0) - 1)
  return Math.min(priority, ...taken)
}

export function readMode(storage = globalThis.localStorage) {
  try { return storage.getItem(STORAGE.surface) === 'agent' ? 'agent' : 'bot' } catch { return 'bot' }
}

export function writeMode(mode, storage = globalThis.localStorage) {
  try { storage.setItem(STORAGE.surface, mode) } catch {}
}
