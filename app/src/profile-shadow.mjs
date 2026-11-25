import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

export function shadowedBundles(profileDir, ownNames) {
  let manifest
  try { manifest = readJson(join(profileDir, 'package.json')) } catch { return [] }
  return Object.keys(manifest?.dependencies ?? {}).filter(name => ownNames.includes(name)
    && existsSync(join(profileDir, 'node_modules', name, 'package.json'))).map((name) => {
    let version = manifest.dependencies[name]
    try { version = readJson(join(profileDir, 'node_modules', name, 'package.json')).version ?? version } catch {}
    return { name, version }
  })
}

const fallbackDirs = (dir, name) => {
  const root = join(dir, '.dsh-module-fallback', 'node_modules')
  return existsSync(join(root, name)) ? [join(root, name)] : []
}

export async function removeShadowed(profileDir, names) {
  const file = join(profileDir, 'package.json')
  for (const name of names) {
    for (const dir of [join(profileDir, 'node_modules', name), ...fallbackDirs(profileDir, name)]) await rm(dir, { recursive: true, force: true })
    const manifest = readJson(file)
    delete manifest.dependencies?.[name]
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}
