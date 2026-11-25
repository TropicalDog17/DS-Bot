import { REGENERABLE_DEFAULT_BYTES } from './import.mjs'
import { formatBytes } from './place.mjs'

export const SPARE_BYTES = 500e6
const CARD_EVERY_MS = 200
const ETA_AFTER_MS = 3000
const CHECK_SHARE = 0.15

export function arcShare(step, fraction) {
  const f = Math.max(0, Math.min(1, fraction || 0))
  return step <= 1 ? CHECK_SHARE * f : step === 2 ? CHECK_SHARE + (1 - CHECK_SHARE) * f : 1
}

export function modelChoices(profiles) {
  const rank = name => ({ desktop: 0, web: 1 })[name] ?? 2
  const sorted = [...profiles].sort((a, b) => rank(a.name) - rank(b.name) || b.rows.length - a.rows.length)
  return sorted.map(profile => ({ id: profile.name, label: modelLabel(profile) }))
}

const PROFILE_NAMES = { desktop: 'DSH Desktop', web: 'DSH Web' }

function modelLabel({ name, rows }) {
  const model = rows.find(row => row?.id === 'agent-default-model')?.config?.model
  const from = PROFILE_NAMES[name] ?? name
  return typeof model === 'string' && model !== '' ? `${from} · ${model}` : from
}

export function copySize(sizes, options) {
  if (sizes.chats === undefined || sizes.work === undefined) return undefined
  const work = options.skipWork ? 0 : sizes.work - (options.regen ? sizes.regen ?? 0 : 0)
  return { chats: sizes.chats, work, total: sizes.chats + work }
}

export const defaultOptions = sizes => ({ regen: (sizes.regen ?? 0) >= REGENERABLE_DEFAULT_BYTES, skipWork: false })

export function etaMinutes(shown, { done, total, elapsedMs }) {
  if (elapsedMs < ETA_AFTER_MS || done <= 0 || total <= 0) return shown
  const left = (Math.max(0, total - done) / done) * elapsedMs
  if (left < 60_000) return 0
  const minutes = Math.ceil(left / 60_000)
  return shown === null || shown === 0 || Math.abs(minutes - shown) >= 1 ? minutes : shown
}

export class ImportFlow {
  #io
  #now
  #models
  #profile
  #options
  #sizes
  #check
  #checkAbort
  #copyCard
  #shownAt = 0
  #timer
  #lastStep = 0

  constructor(io) {
    this.#io = io
    this.#now = io.now ?? Date.now
    this.#models = modelChoices(io.offer.profiles)
    this.#profile = this.#models[0]?.id
    this.#sizes = io.offer.sizes
    this.#options = defaultOptions(this.#sizes)
  }

  card() {
    const { offer } = this.#io
    const size = copySize(this.#sizes, this.#options)
    const model = this.#models.find(entry => entry.id === this.#profile)
    return {
      kind: 'import', bots: offer.bots, groups: offer.rooms, sessions: offer.sessions, path: offer.from,
      names: offer.names.slice(0, 3).join(', '),
      bare: size === undefined ? 'Bare' : '',
      ...(size === undefined ? {} : { chats: formatBytes(size.chats), work: formatBytes(size.work), total: formatBytes(size.total) }),
      model: model?.label ?? '', models: this.#models.length > 1 ? this.#models : [],
      options: { ...this.#options },
    }
  }

  act(name, value) {
    if (name === 'importModel' && this.#models.some(entry => entry.id === value)) {
      this.#profile = value
      this.#io.show(this.card())
    } else if (name === 'importOption' && value !== null && typeof value === 'object' && ['regen', 'skipWork'].includes(value.option)) {
      this.#options = { ...this.#options, [value.option]: value.value === true }
      this.#io.show(this.card())
    }
  }

  async run() {
    const io = this.#io
    try {
      this.#startCheck()
      const answer = await io.ask(this.card())
      if (answer !== 'copy') return { outcome: answer === 'skip' ? 'skipped' : answer === 'pick' ? 'pick' : 'gone' }
      const short = this.#short()
      if (short !== undefined) {
        const next = await io.ask({ kind: 'importSpace', ...short })
        return { outcome: next === 'skip' ? 'skipped' : next === 'pick' ? 'pick' : 'gone' }
      }
      return await this.#copyLoop()
    } finally {
      clearTimeout(this.#timer)
      this.#checkAbort?.abort()
      io.progress?.(-1)
    }
  }

  #short() {
    const size = copySize(this.#sizes, this.#options)
    const { free, drive } = this.#io.room()
    if (size === undefined || free === undefined) return undefined
    const need = size.total + SPARE_BYTES
    if (free >= need) return undefined
    const text = bytes => formatBytes(bytes)
    return { need: text(need), free: text(free), short: text(need - free), drive: drive ?? '' }
  }

  #startCheck() {
    this.#checkAbort?.abort()
    this.#check = undefined
    if (this.#io.inUse()) return
    const abort = new AbortController()
    this.#checkAbort = abort
    const signal = AbortSignal.any([abort.signal, this.#io.signal])
    const state = { progress: { done: 0, total: this.#io.offer.sessions }, listener: () => {}, stale: false }
    this.#check = state
    state.result = this.#io.check(signal, (done, total) => {
      state.progress = { done, total }
      state.listener(done, total)
    })
    state.result.catch(() => {})
    void this.#io.until(() => this.#io.inUse(), signal).then(() => {
      if (signal.aborted) return
      state.stale = true
      abort.abort()
    })
  }

  async #waitFree() {
    const io = this.#io
    const free = new AbortController()
    const next = await io.ask({ kind: 'inUse' }, { settle: io.until(() => !io.inUse(), AbortSignal.any([free.signal, io.signal])) })
    free.abort()
    return next === 'settled' ? undefined : { outcome: next === 'skip' ? 'skipped' : 'gone' }
  }

  async #copyLoop() {
    const io = this.#io
    for (;;) {
      const signal = io.signal
      try {
        const unreadable = await this.#checked(signal)
        if (typeof unreadable === 'object') return unreadable
        if (unreadable > 0) {
          const next = await io.ask({ kind: 'newer', n: unreadable })
          return next === 'startWithout' ? { outcome: 'skipped', newer: true } : { outcome: 'gone' }
        }
        const size = copySize(this.#sizes, this.#options)
        const total = size?.total ?? 0
        const of = size === undefined ? '…' : formatBytes(total)
        const checkedStep = this.#copyCard?.steps?.[0] ?? {}
        let eta = null
        this.#setCopy({ step: 2, steps: [checkedStep, { a: formatBytes(0), b: of }, {}], fraction: 0, eta: null })
        await io.warmed()
        signal.throwIfAborted()
        const started = this.#now()
        const summary = await io.copy({
          profile: this.#profile, leaveRegenerable: this.#options.regen, skipWork: this.#options.skipWork, signal,
          onProgress: (bytes) => {
            const done = total > 0 ? Math.min(bytes, total) : bytes
            eta = etaMinutes(eta, { done, total, elapsedMs: this.#now() - started })
            this.#setCopy({ step: 2, steps: [checkedStep, { a: formatBytes(done), b: of }, {}], fraction: total > 0 ? done / total : 0, eta })
          },
        })
        this.#setCopy({ step: 3, steps: [checkedStep, { ...this.#copyCard.steps[1], a: of === '…' ? this.#copyCard.steps[1].a : of }, {}], fraction: 0, eta: null }, true)
        return { outcome: 'copied', summary }
      } catch (error) {
        if (io.signal.aborted) return { outcome: 'gone' }
        const message = error instanceof Error ? error.message : String(error)
        const next = await io.ask({ kind: 'importFailed', reason: io.reasonOf(error), log: message.split('\n') })
        if (next !== 'retry') return { outcome: next === 'startWithout' ? 'skipped' : 'gone' }
        this.#copyCard = undefined
      }
    }
  }

  async #checked(signal) {
    const step1 = (done, total) => {
      this.#setCopy({ step: 1, steps: [{ a: done, b: total }, {}, {}], fraction: total > 0 ? done / total : 0, eta: null })
    }
    for (;;) {
      if (this.#check === undefined || this.#check.stale) {
        if (this.#io.inUse()) {
          const away = await this.#waitFree()
          if (away !== undefined) return away
        }
        this.#startCheck()
        if (this.#check === undefined) continue
      }
      const check = this.#check
      check.listener = step1
      step1(check.progress.done, check.progress.total)
      const unreadable = await Promise.race([check.result, aborted(signal)])
      signal.throwIfAborted()
      if (!check.stale) return unreadable
    }
  }

  #setCopy(card, now = false) {
    this.#copyCard = card
    this.#showCopy(now)
  }

  #showCopy(now) {
    const card = this.#copyCard
    if (card === undefined) return
    const send = () => {
      this.#timer = undefined
      this.#shownAt = this.#now()
      const { steps, step, fraction } = this.#copyCard
      this.#lastStep = step
      this.#io.progress?.(Math.min(1, (step - 1 + Math.max(0, Math.min(1, fraction))) / 3))
      this.#io.show({ ...this.#copyCard, kind: 'copying', steps: steps.map(entry => ({ ...entry })), arc: arcShare(step, fraction) })
    }
    const due = this.#shownAt + CARD_EVERY_MS - this.#now()
    if (now || due <= 0 || this.#lastStep !== card.step) {
      clearTimeout(this.#timer)
      send()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(send, due)
    }
  }
}

function aborted(signal) {
  return new Promise((resolve, reject) => {
    const away = () => { reject(signal.reason ?? new Error('stopped')) }
    if (signal.aborted) away()
    else signal.addEventListener('abort', away, { once: true })
  })
}
