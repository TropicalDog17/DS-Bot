import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

// Loaded on the first call, not with this file, so that undici's own start-up (it installs a
// default global dispatcher when none exists) happens after the launcher's proxy policy.
let undici
const loadUndici = () => undici ??= import('undici')

const FORWARD_HEADERS = ['mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'accept', 'content-type']
const RETURN_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version']
const RETRYABLE = new Set(['GET', 'POST', 'DELETE'])

const nonceMatches = (header, nonce) => {
  const given = /^Bearer\s+(.+)$/i.exec(String(header ?? ''))?.[1] ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(nonce)
  return a.length === b.length && timingSafeEqual(a, b)
}

const sseMessage = (body) => {
  const frames = []
  for (const block of String(body).split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (data !== '') frames.push(data)
  }
  return frames.length === 1 ? frames[0] : null
}

const loopbackHttp = url => /^http:\/\/(127\.|localhost|::1)/i.test(String(url))

const readAll = (stream): Promise<Buffer> => new Promise((resolve, reject) => {
  if (stream.errored) { reject(stream.errored); return }
  const chunks = []
  stream.on('data', chunk => chunks.push(chunk))
  stream.on('end', () => resolve(Buffer.concat(chunks)))
  stream.on('error', reject)
})

export function createGateway({ credential, readOnly, onUnauthorized, log = (() => {}) as (...args: any[]) => void }) {
  const nonce = randomBytes(24).toString('base64url')
  let server = null
  let port = 0
  const annotations = new Map()

  const toolReadOnly = (id, name) => {
    const flags = annotations.get(id)
    return flags?.get(name) === true
  }

  const processList = (id, result, filtered) => {
    const tools = Array.isArray(result?.result?.tools) ? result.result.tools : null
    if (tools === null) return result
    let flags = annotations.get(id)
    if (flags === undefined) annotations.set(id, flags = new Map())
    for (const tool of tools) flags.set(tool.name, tool.annotations?.readOnlyHint === true)
    if (!filtered) return result
    return { ...result, result: { ...result.result, tools: tools.filter(tool => tool.annotations?.readOnlyHint === true) } }
  }

  const refuseCall = (id, rpc) => ({
    jsonrpc: '2.0',
    id: rpc?.id ?? null,
    error: { code: -32600, message: `The ${id} connector is read-only: this tool can change things, so it is off. Turn off the read-only switch in Settings → Connectors to use it.` },
  })

  const signInAgain = (id, body, upstream, res) => {
    let rpc
    try { rpc = JSON.parse(body?.toString('utf8') ?? '') } catch { return false }
    if (rpc === null || typeof rpc !== 'object' || Array.isArray(rpc) || rpc.id === undefined) return false
    upstream.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: rpc.id,
      error: { code: -32001, message: `The ${id} connector needs sign-in again. Call request_connector with id ${id} so the user can sign in, or ask them to sign in under Settings → Connectors.` },
    }))
    return true
  }

  // undici's own `request`, which takes the process-wide dispatcher the launcher installed, so the
  // proxy policy applies and this file holds no proxy code. `fetch` would do the same but ties
  // every call to undici's 300 s header and idle limits, and an MCP stream may stay quiet for far
  // longer; `request` takes its limits per call, and both are off here. It also sends only the
  // headers named here, and does not follow a redirect (the server's answer, not something to
  // follow with the credential attached). It would speak HTTP/2 to a server that offers it; the
  // old client spoke HTTP/1.1 only, so that is kept. The answer is a stream and is never buffered
  // here. `signal` ends the call when the client leaves.
  async function sendUpstream(id, entry, method, path, headers, body, signal) {
    const { request } = await loadUndici()
    const target = new URL(entry.url)
    const suffix = new URL(path, 'http://x')
    if (suffix.pathname !== '/') {
      target.pathname = `${target.pathname.replace(/\/$/, '')}/${suffix.pathname.replace(/^\//, '')}`
    }
    for (const [key, value] of suffix.searchParams) target.searchParams.append(key, value)
    const outgoing = { ...entry.headers }
    for (const name of FORWARD_HEADERS) if (headers[name] !== undefined) outgoing[name] = headers[name]
    if (target.username !== '' || target.password !== '') {
      if (!Object.keys(outgoing).some(name => name.toLowerCase() === 'authorization')) {
        outgoing.authorization = `Basic ${Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString('base64')}`
      }
      target.username = ''
      target.password = ''
    }
    const response = await request(target, { method, headers: outgoing, body, signal, headersTimeout: 0, bodyTimeout: 0, allowH2: false })
    const upstream = response.body
    // This listener must exist before refresh awaits: the response can fail
    // before the handler starts consuming it.
    upstream.on('error', () => {})
    upstream.statusCode = response.statusCode
    upstream.headers = response.headers
    // GET 405 is the normal answer from servers without a standalone stream.
    if (upstream.statusCode >= 400 && !(method === 'GET' && upstream.statusCode === 405)) log('ds-bot: connector %s upstream %s HTTP %s (session: %s)', id, method, upstream.statusCode, headers['mcp-session-id'] !== undefined)
    return upstream
  }

  async function handle(id, req, res) {
    const entry = credential(id)
    if (entry === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'connector not connected' }))
      return
    }
    if (!/^https:\/\//i.test(entry.url) && !loopbackHttp(entry.url)) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'connector address must be https' }))
      return
    }
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    const suffix = req.url.slice(`/c/${id}`.length)
    const path = suffix === '' ? '/' : suffix
    const limited = readOnly(id) === true
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readAll(req)
    if (limited && req.method === 'POST' && body !== undefined) {
      let rpc
      try { rpc = JSON.parse(body.toString('utf8')) } catch { rpc = null }
      if (Array.isArray(rpc)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `The ${id} connector is read-only: batched calls are refused.` } }))
        return
      }
      if (rpc?.method === 'tools/call' && !toolReadOnly(id, rpc.params?.name)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(refuseCall(id, rpc)))
        return
      }
      if (rpc?.method === 'tools/list') {
        let upstream = await sendUpstream(id, entry, req.method, path, req.headers, body, abort.signal)
        if (upstream.statusCode === 401) {
          const retried = await onUnauthorized(id)
          if (retried === true) {
            upstream.resume()
            upstream = await sendUpstream(id, credential(id) ?? entry, req.method, path, req.headers, body, abort.signal)
          }
        }
        if (upstream.statusCode === 401 && signInAgain(id, body, upstream, res)) return
        const raw = await readAll(upstream)
        const isSse = String(upstream.headers['content-type'] ?? '').includes('text/event-stream')
        const payload = isSse ? sseMessage(raw.toString('utf8')) : raw.toString('utf8')
        let out = raw
        try {
          const parsed = payload === null ? null : JSON.parse(payload)
          if (parsed !== null) {
            const filtered = JSON.stringify(processList(id, parsed, true))
            out = isSse ? Buffer.from(`event: message\ndata: ${filtered}\n\n`) : Buffer.from(filtered)
          }
        } catch { /* pass the answer through unchanged */ }
        const heads = {}
        for (const name of RETURN_HEADERS) if (upstream.headers[name] !== undefined) heads[name] = upstream.headers[name]
        if (!isSse) heads['content-length'] = out.length
        else delete heads['content-length']
        res.writeHead(upstream.statusCode ?? 502, heads)
        res.end(out)
        return
      }
    }
    if (!RETRYABLE.has(req.method)) {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    let upstream
    try {
      upstream = await sendUpstream(id, entry, req.method, path, req.headers, body, abort.signal)
      if (upstream.statusCode === 401) {
        const retried = await onUnauthorized(id)
        if (retried === true) {
          upstream.resume()
          upstream = await sendUpstream(id, credential(id) ?? entry, req.method, path, req.headers, body, abort.signal)
        }
      }
      if (upstream.errored) throw upstream.errored
    } catch (error) {
      if (!abort.signal.aborted) log('ds-bot: connector gateway %s: %s', id, error?.message ?? error)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'connector upstream failed' }))
      return
    }
    if (upstream.statusCode === 401 && req.method === 'POST' && signInAgain(id, body, upstream, res)) return
    const isList = req.method === 'POST' && body !== undefined && (() => { try { return JSON.parse(body.toString('utf8'))?.method === 'tools/list' } catch { return false } })()
    const heads = {}
    for (const name of RETURN_HEADERS) if (upstream.headers[name] !== undefined) heads[name] = upstream.headers[name]
    if (!isList || limited) {
      const close = () => { upstream.destroy() }
      res.on('close', close)
      upstream.on('end', () => res.off('close', close))
      upstream.on('error', () => {
        if (!abort.signal.aborted) log('ds-bot: connector %s upstream %s stream failed', id, req.method)
        res.destroy()
      })
      res.writeHead(upstream.statusCode ?? 502, heads)
      upstream.pipe(res)
      return
    }
    const raw = await readAll(upstream)
    try {
      const isSse = String(upstream.headers['content-type'] ?? '').includes('text/event-stream')
      const payload = isSse ? sseMessage(raw.toString('utf8')) : raw.toString('utf8')
      if (payload !== null) processList(id, JSON.parse(payload), false)
    } catch { /* annotations stay as they were */ }
    res.writeHead(upstream.statusCode ?? 502, heads)
    res.end(raw)
  }

  return {
    get port() { return port },
    get nonce() { return nonce },
    urlFor(id) { return `http://127.0.0.1:${port}/c/${id}` },
    headers() { return { Authorization: `Bearer ${nonce}` } },
    forget(id) { annotations.delete(id) },
    async listen() {
      if (server !== null) return
      server = createServer((req, res) => {
        req.on('error', () => res.destroy())
        res.on('error', () => req.destroy())
        const found = /^\/c\/([A-Za-z0-9_-]{1,32})/.exec(req.url ?? '')
        if (found === null || !nonceMatches(req.headers.authorization, nonce)) {
          res.writeHead(404)
          res.end()
          return
        }
        handle(found[1], req, res).catch((error) => {
          if (error?.name !== 'AbortError') log('ds-bot: connector gateway: %s', error?.message ?? error)
          if (res.headersSent) res.destroy()
          else { res.writeHead(502); res.end() }
        })
      })
      server.on('error', error => log('ds-bot: connector gateway server failed: %s', error?.code ?? 'error'))
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      port = server.address().port
    },
    async close() {
      const closing = server
      server = null
      if (closing !== null) await new Promise(resolve => closing.close(resolve))
      annotations.clear()
    },
  }
}
