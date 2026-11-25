// Follows DeepSeek Harness apps/desktop-host/src/office.ts (MIT); see NOTICE.
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { Config as SkillOfficeConfig } from '@deepseek-ai/dsh-skill-office'
import { stringify } from 'yaml'

export const OFFICE_PATCH_NAME = 'office.patch.yml'

export function officeRuntime(runtimeDir) {
  const source = join(runtimeDir, 'primary-runtime')
  const node = join(source, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  if (!existsSync(join(source, 'runtime.json')) || !existsSync(node)
    || !existsSync(join(runtimeDir, 'office-skills', 'office', 'SKILL.md'))) return undefined
  return { source, node }
}

// The payload's Node is a plain interpreter: it cannot read through the asar archive, so the
// CLI must come from the unpacked tree electron-builder writes beside it.
export function officeCli(manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))) {
  return join(dirname(manifest).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`), 'lib', 'cli.js')
}

export function reconcileOfficeRuntime(profile, runtimeDir = process.env.DS_BOT_RUNTIME_DIR, { skillConfig = SkillOfficeConfig } = {}) {
  const file = join(dirname(profile.dir), OFFICE_PATCH_NAME)
  const runtime = runtimeDir === undefined ? undefined : officeRuntime(runtimeDir)
  if (runtime === undefined) {
    rmSync(file, { force: true })
    return { patchFiles: [] }
  }
  const usesPythonEnvironment = 'pythonEnvironment' in (skillConfig?.dict ?? {})
  const desired = [
    { id: 'workspace-dependencies', name: '@deepseek-ai/dsh-tool-workspace-dependencies', config: { source: runtime.source } },
    {
      id: 'skill-office',
      name: '@deepseek-ai/dsh-skill-office',
      config: usesPythonEnvironment
        ? { assetRoot: join(runtimeDir, 'office-skills'), pythonEnvironment: 'workspace-dependencies' }
        : { assetRoot: join(runtimeDir, 'office-skills'), node: runtime.node, cli: officeCli() },
    },
  ]
  const existing = new Set(composeEntries([...profile.layers.map(layer => layer.patches), profile.patches]).map(entry => entry.id))
  const inserted = desired.filter(entry => !existing.has(entry.id))
  const overridden = desired.filter(entry => existing.has(entry.id)).map(entry => ({ ...entry, disabled: false }))
  const patches = [...(inserted.length > 0 ? [{ insert: inserted }] : []), ...overridden]
  writeFileSync(file, stringify(patches), 'utf8')
  return { patchFiles: [file], node: runtime.node }
}
