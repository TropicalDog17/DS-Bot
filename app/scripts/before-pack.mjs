import { Arch } from 'electron-builder'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { preparePrimaryRuntime, runtimeTarget } from './prepare-runtime.mjs'

const WHERE = {
  darwin: { x64: 'on an Intel Mac, or under Rosetta with an x64 Node', arm64: 'on a Mac with Apple silicon' },
}

export function archProblem({ target, platform, host = process.arch, targets = [] }) {
  // electron-builder packs a universal app one architecture at a time: the hook only sees the
  // inner x64/arm64 builds, so a universal request is known from the requested targets.
  if (target === 'universal' || targets.includes('universal')) return 'A universal app would need the native modules of both architectures. Build one app per architecture.'
  if (target === host) return undefined
  const where = WHERE[platform]?.[target] ?? `with an ${target} Node`
  return `This Node runs on ${host}, so npm installed ${host} native modules, and an ${target} app with them would not start. Install the dependencies and build ${where}.`
}

export function officeRuntimeRequest(context) {
  const target = runtimeTarget(context.electronPlatformName, Arch[context.arch])
  if (target === undefined) throw new Error(`No Office runtime payload for ${context.electronPlatformName} ${Arch[context.arch]}.`)
  const appDir = context.packager.appDir ?? context.packager.projectDir
  return {
    target,
    output: join(appDir, 'build', 'runtime'),
    cache: process.env.DS_BOT_RUNTIME_CACHE ?? join(appDir, 'build', 'runtime-cache'),
    version: context.packager?.appInfo?.version
      ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  }
}

export async function beforePack(context, prepare = preparePrimaryRuntime) {
  const targets = []
  for (const archToNames of context.packager?.packagerOptions?.targets?.values() ?? [])
    for (const arch of archToNames.keys()) targets.push(Arch[arch])
  const problem = archProblem({ target: Arch[context.arch], platform: context.electronPlatformName, targets })
  if (problem !== undefined) throw new Error(problem)
  await prepare(officeRuntimeRequest(context))
}
