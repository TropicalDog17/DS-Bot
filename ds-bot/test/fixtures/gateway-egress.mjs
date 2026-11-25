import { createRequire } from 'node:module'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { createGateway } from '../../src/host/connectors/gateway.ts'

const { upstream, undiciTimeoutMs, headers = { Authorization: 'Bearer private-token' }, control } = JSON.parse(process.env.GATEWAY_EGRESS)

await installProxyFromEnvironment(new Map(Object.entries(process.env).map(([name, value]) => [name, { value }])), message => process.stderr.write(`policy: ${message}\n`))
if (undiciTimeoutMs !== undefined) {
  const undici = createRequire(import.meta.resolve('@deepseek-ai/dsh-http-proxy'))('undici')
  undici.setGlobalDispatcher(new undici.Agent({ headersTimeout: undiciTimeoutMs, bodyTimeout: undiciTimeoutMs }))
}

const gateway = createGateway({
  credential: () => ({ url: upstream, headers }),
  readOnly: () => false,
  onUnauthorized: async () => false,
  log: (...args) => process.stderr.write(`gateway: ${args.join(' ')}\n`),
})
await gateway.listen()
process.stdout.write(`${JSON.stringify({ url: gateway.urlFor('svc'), headers: gateway.headers() })}\n`)
if (control !== undefined) {
  const outcome = async () => {
    try {
      await (await fetch(control, { method: 'POST', body: '{}' })).arrayBuffer()
      return 'none'
    } catch (error) {
      return error.cause?.code ?? error.message
    }
  }
  outcome().then(code => process.stdout.write(`${JSON.stringify({ control: code })}\n`))
}
process.stdin.resume()
process.stdin.on('end', async () => {
  await gateway.close()
  process.exit(0)
})
