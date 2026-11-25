import { register, registerHooks } from 'node:module'

export const installHooks = async () => {
  if (typeof registerHooks === 'function') {
    const { resolve } = await import('./hooks.mjs')
    registerHooks({ resolve })
    return
  }
  register('./loader.mjs', import.meta.url)
  await new Promise(done => { setImmediate(done) })
}
