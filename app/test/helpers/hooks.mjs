const here = new URL('./', import.meta.url)

export function resolve(specifier, context, nextResolve) {
  const fake = (name) => ({ url: new URL(name, here).href, shortCircuit: true })
  if (specifier === 'electron') return fake('fake-electron.mjs')
  if (specifier === 'electron-updater') return fake('fake-updater.mjs')
  if (specifier === '@deepseek-ai/dsh-app-boot') return fake('fake-app-boot.mjs')
  const resolved = nextResolve(specifier, context)
  if (resolved.url.endsWith('/app/src/host-process.mjs')) return fake('fake-host-process.mjs')
  return resolved
}
