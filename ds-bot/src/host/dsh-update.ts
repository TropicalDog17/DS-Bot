import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  CHECK_TTL_MS, cleanVersion, encodeName, fetchJson, installSpecOf,
  newer, registryPlan, repoSlug, sourceOf,
} from './update.ts'

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const APP_BOOT = '@deepseek-ai/dsh-app-boot'
const DSH_PACKAGE = '@deepseek-ai/dsh'

export function install(rt) {
  const { ctx, config } = rt
  const enabled = config.updateCheck !== false

  const status = {
    current: null, verified: null, kind: 'npm', blockedBy: null,
    checkedAt: 0, phase: 'idle', installed: null, error: null,
  }
  let target = null
  let checking = null
  let running = null

  const blocked = () => status.blockedBy !== null && newer(status.blockedBy, PKG.version)

  const view = () => ({
    current: status.current, verified: status.verified, kind: status.kind, blockedBy: status.blockedBy,
    checkedAt: status.checkedAt, phase: status.phase, installed: status.installed, error: status.error,
    available: status.phase !== 'installed' && target !== null && status.current !== null
      && status.verified !== null && status.verified !== status.current && !blocked(),
  })

  async function currentDsh() {
    try {
      const loader = ctx.get?.('loader')
      const loaded = await loader?.import?.(APP_BOOT)
      const appBoot = loader?.unwrapExports?.(loaded) ?? loaded?.default ?? loaded
      const version = cleanVersion(appBoot?.getDshRuntimeVersion?.())
      if (version) return version
    } catch {}
    let dir = dirname(String(process.argv[1] ?? ''))
    for (let depth = 0; depth < 12; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (manifest?.name?.startsWith?.('@deepseek-ai/')) {
          const version = cleanVersion(manifest.version)
          if (version) return version
        }
      } catch {}
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  // A bundled package manager means the runtime came with the app and only the
  // app's own updater can move it.
  const installKind = () =>
    typeof ctx.get?.('profileContext')?.packageManager?.command === 'string' ? 'app' : 'npm'

  async function releasedDeclaration(source) {
    if (source.kind === 'registry') {
      for (const registry of await registryPlan(config, ctx.get?.('pluginManager'))) {
        try {
          const manifest = await fetchJson(`${registry}${encodeName(PKG.name)}/latest`)
          if (manifest?.dsBot?.verifiedDsh) return manifest.dsBot
        } catch {}
      }
      return null
    }
    const repo = repoSlug()
    if (!repo) return null
    try {
      const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, { 'user-agent': `${PKG.name}/${PKG.version}` })
      const tag = cleanVersion(release?.tag_name)
      if (!tag) return null
      const manifest = await fetchJson(`https://raw.githubusercontent.com/${repo}/${release.tag_name}/ds-bot/package.json`, { 'user-agent': `${PKG.name}/${PKG.version}` })
      return manifest?.dsBot?.verifiedDsh ? manifest.dsBot : null
    } catch { return null }
  }

  async function runCheck() {
    try {
      status.current = await currentDsh()
      status.kind = installKind()
      const inApp = process.env.DS_BOT_APP === '1'
      const declared: Record<string, any>[] = inApp ? [] : [{ verifiedDsh: PKG.dsBot?.verifiedDsh }]
      const released = inApp ? null : await releasedDeclaration(sourceOf(await installSpecOf(ctx)))
      if (released) declared.push(released)
      const newestDeclared = declared
        .filter(entry => cleanVersion(entry.verifiedDsh))
        .sort((a, b) => (newer(cleanVersion(a.verifiedDsh), cleanVersion(b.verifiedDsh)) ? -1 : 1))[0]
      status.verified = cleanVersion(newestDeclared?.verifiedDsh)
      status.blockedBy = cleanVersion(newestDeclared?.minBot)
      target = status.current !== null && status.verified !== null && status.verified !== status.current
        ? { version: status.verified }
        : null
      status.error = null
    } catch (error) {
      rt.warn('ds-bot: dsh update check failed: %s', error?.message ?? error)
      status.verified = null
      status.blockedBy = null
      target = null
    }
    status.checkedAt = Date.now()
  }

  async function check({ fresh = false } = {}) {
    if (!enabled) return view()
    if (checking) return checking
    if (!fresh && Date.now() - status.checkedAt < CHECK_TTL_MS) return view()
    checking = runCheck().finally(() => { checking = null })
    await checking
    return view()
  }

  function start() {
    if (status.phase === 'installing') return view()
    if (target === null || blocked()) throw new Error('No DSH update is available')
    if (status.kind !== 'npm') throw new Error('This DSH updates with its app')
    const chosen = target
    Object.assign(status, { phase: 'installing', error: null })
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const args = ['install', '-g', `${DSH_PACKAGE}@${chosen.version}`]
    const runner = rt.dshSpawn ?? ((command, argv, options) => spawn(command, argv, options))
    running = runner(npm, args, { windowsHide: true })
    let output = ''
    running.stdout?.on?.('data', chunk => { output = `${output}${chunk}`.slice(-4000) })
    running.stderr?.on?.('data', chunk => { output = `${output}${chunk}`.slice(-4000) })
    const done = new Promise<void>((resolve, reject) => {
      running.once?.('error', reject)
      running.once?.('close', code => (code === 0 ? resolve() : reject(new Error(`npm exited ${code}`))))
    })
    void done
      .then(() => Object.assign(status, { phase: 'installed', installed: chosen.version }))
      .catch((error) => {
        rt.warn('ds-bot: dsh update to %s failed: %s', chosen.version, error?.message ?? error)
        Object.assign(status, { phase: 'failed', error: `${error?.message ?? error}${output ? ` — ${output.trim().slice(-400)}` : ''}`.slice(0, 600) })
      })
    return view()
  }

  ctx.effect(() => () => running?.kill?.(), 'ds-bot: dsh update install')

  Object.assign(rt, { dshUpdateCheck: check, dshUpdateStart: start, dshUpdateView: view })
}
