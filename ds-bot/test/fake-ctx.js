export function fakeAttachments() {
  const files = new Map()
  let next = 0
  const id = () => `sha256:${String(++next).padStart(64, '0')}`
  return {
    files,
    async saveFile({ data, name }) {
      const ref = { attachmentId: id(), name, bytes: data.length }
      files.set(ref.attachmentId, data)
      return ref
    },
    async saveImage({ data, mediaType, width, height }) {
      const ref = { attachmentId: id(), mediaType, bytes: data.length, width, height }
      files.set(ref.attachmentId, data)
      return ref
    },
    async* readFileStream(ref) {
      if (typeof ref.name !== 'string' || ref.name === '') throw Object.assign(new Error('File attachment reference is invalid.'), { code: 'INVALID_ATTACHMENT_REF' })
      const data = files.get(ref.attachmentId)
      if (data === undefined) throw new Error('no such file')
      for (let at = 0; at < data.length; at += 1001) yield data.subarray(at, at + 1001)
    },
    async readImage(ref) {
      const data = files.get(ref.attachmentId)
      if (data === undefined || ref.name !== undefined) throw Object.assign(new Error('Image attachment reference is invalid.'), { code: 'INVALID_ATTACHMENT_REF' })
      return { ref, data: new Uint8Array(data) }
    },
  }
}

export function fakeApproval(outcome = 'allowed-once') {
  const requests = []
  return {
    requests,
    async request(request) {
      requests.push(request)
      return typeof outcome === 'function' ? outcome(requests.length, request) : outcome
    },
  }
}

export function fakeContext({ services = {} } = {}) {
  const calls = []
  const disposers = []
  const registeredTools = new Map()
  const guards = []
  const listeners = new Map()
  const sections = new Map()
  const contexts = new Map()
  const ctx = {
    calls,
    registeredTools,
    guards,
    listeners,
    sections,
    contexts,
    logger: { warn() {}, info() {} },
    get: name => services[name],
    // As in real cordis: the plugin does not inject this service, so reading it throws.
    get subagents() { throw new Error('cannot get property "subagents" without inject') },
    // The real ctx guards plain access with `inject`; service() reads this.
    reflect: { get: name => ctx.get(name) },
    on(name, listener, options) {
      calls.push(`on ${name}${options?.prepend ? ' (prepend)' : ''}`)
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) {
        if (listener.length < 2) listener(payload)
      }
    },
    async emitAsync(name, payload) {
      for (const listener of listeners.get(name) ?? []) {
        if (listener.length < 2) await listener(payload)
      }
    },
    scopeAgent(sessionId) {
      return {
        id: sessionId,
        session: { id: sessionId },
        ctx: {
          tools: { register: (tool) => { registeredTools.set(tool.name, tool); return () => {} } },
          effect: () => {},
          on: () => () => {},
        },
      }
    },
    effect(execute, label) {
      calls.push(`effect ${label}`)
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    dispose() {
      return Promise.allSettled(disposers.splice(0).reverse().map(dispose => dispose()))
    },
    tools: {
      register(tool) {
        calls.push(`tool ${tool.name}`)
        registeredTools.set(tool.name, tool)
        return () => {}
      },
      guard(guard) {
        calls.push('tools guard')
        guards.push(guard)
        return () => {}
      },
      schemas: () => [],
    },
    systemPrompt: {
      section(section) {
        calls.push(`prompt ${section.name} ${section.order}`)
        sections.set(section.name, section)
        return () => {}
      },
      context(context) {
        contexts.set(context.name, context)
        return () => { contexts.delete(context.name) }
      },
    },
    connection: {
      fetch: {
        register(route) {
          calls.push(`route ${route.methods.join(',')} ${route.path}`)
          return () => {}
        },
      },
    },
    llm: {
      listProviders: () => [],
      registerAdapter: (routes, adapter) => {
        ctx.adapters = [...(ctx.adapters ?? []), { routes, adapter }]
        const handle = () => {}
        handle.replace = (next) => { ctx.adapters.at(-1).routes = next }
        return handle
      },
    },
  }
  return ctx
}
