const here = new URL('./', import.meta.url)
const fake = (name) => ({ url: new URL(name, here).href, shortCircuit: true })

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return fake('fake-electron.mjs')
  if (specifier === 'electron-updater') return fake('fake-updater.mjs')
  if (specifier === '@deepseek-ai/dsh-app-boot') return fake('fake-app-boot.mjs')
  const resolved = await nextResolve(specifier, context)
  if (resolved.url.endsWith('/app/src/host-process.mjs')) return fake('fake-host-process.mjs')
  return resolved
}
