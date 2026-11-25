import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class BackgroundNotice {
  #marker
  #show
  #focus
  #message
  #confirm
  #log
  #acknowledged = false
  #pending = false
  #disposed = false

  constructor(options) {
    this.#marker = options.marker
    this.#show = options.show
    this.#focus = options.focus ?? (() => {})
    this.#message = options.message
    this.#confirm = options.confirm
    this.#log = options.log ?? console
  }

  close(hide) {
    if (this.#disposed) return
    if (this.#pending) { this.#focus(); return }
    if (this.#acknowledged || existsSync(this.#marker)) {
      this.#acknowledged = true
      hide()
      return
    }
    this.#pending = true
    void this.#ask(hide)
  }

  dispose() { this.#disposed = true }

  async #ask(hide) {
    try {
      const { response, unasked = false } = await this.#show({
        type: 'info', title: 'DS Bot', message: this.#message,
        buttons: [this.#confirm], defaultId: 0, cancelId: -1, noLink: true,
      })
      if (this.#disposed || response !== 0) return
      if (unasked) { hide(); return }
      this.#acknowledged = true
      try {
        mkdirSync(dirname(this.#marker), { recursive: true })
        writeFileSync(this.#marker, '')
      } catch (error) {
        this.#log.warn(`DS Bot: the tray notice was not remembered: ${error instanceof Error ? error.message : String(error)}`)
      }
      hide()
    } catch (error) {
      this.#log.warn(`DS Bot: the tray notice could not be shown: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.#pending = false
    }
  }
}
