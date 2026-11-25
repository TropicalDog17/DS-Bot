import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { replaceFile } from '../files.ts'
import { viewCardText } from '../parts.ts'
import { questionTitle, questionsOf } from '../question-card.ts'
import { imPlatform, IM_PLATFORMS } from '../../shared/im-platforms.ts'
import { createReplyOrigin } from '../reply-origin.ts'
import { createImOutbox } from './outbox.ts'
import { adapters } from './platforms/index.ts'

const RECONCILE_MS = 15_000
const RUNTIME_SAVE_MS = 400
const TYPING_MS = 4_000
const NUMBERS = /^\s*\d+(\s+\d+)*\s*$/
const PUSHED_MAX = 200

const secretField = key => key.replace(/[A-Z]/g, char => `_${char}`).toUpperCase()

export function install(rt) {
  const { ctx, state } = rt
  const imDir = join(rt.home, 'im')
  const langKey = () => {
    const label = String(rt.uiLanguage?.() ?? '')
    if (label.startsWith('Traditional Chinese')) return 'zh-TW'
    if (label.startsWith('Chinese')) return 'zh'
    if (label.startsWith('Japanese')) return 'ja'
    if (label.startsWith('Korean')) return 'ko'
    if (label.startsWith('Spanish')) return 'es'
    if (label.startsWith('French')) return 'fr'
    if (label.startsWith('German')) return 'de'
    return 'en'
  }
  const text = (key, values: Record<string, any> = {}) => {
    const lang = langKey()
    const table = {
      en: {
        requested: 'A connection request was sent to DS Bot; allow it in Settings → IM on the computer.',
        unbound: 'This IM bot is not bound to a Bot yet; pick one in DS Bot Settings → IM.',
        unboundGroup: 'This group is not bound yet; pick a group or a Bot for it in DS Bot Settings → IM.',
        connected: `Connected — you can talk to ${values.target} now.`,
        stopped: 'Stopped.',
        idle: 'Nothing is running.',
        stale: 'This card was already answered.',
        noFile: 'This file cannot be sent here; send it on the computer.',
        noFileOut: `${values.name} could not be sent here; open it on the computer.`,
        greeting: `Hello, I am ${values.name}.`,
        question: `${values.bot} asks: `,
        approval: `${values.bot} asks for approval: `,
        secretAsk: `${values.bot} needs the key ${values.name} — fill it on the computer or the phone app.`,
        viewShow: `${values.bot} shared a card — answer it on the computer or the phone app.`,
        answered: 'answered',
        numbers: 'reply with the number',
        numbersMulti: 'reply with the numbers, separated by spaces',
        allow: 'Allow once',
        reject: 'Reject',
      },
      zh: {
        requested: '已向 DS Bot 发出连接请求，请在电脑上的 DS Bot 设置 → IM 里允许。',
        unbound: '这个 IM 机器人还没绑定 Bot，请在 DS Bot 设置 → IM 里选一个。',
        unboundGroup: '这个群还没绑定，请在 DS Bot 设置 → IM 里给它选一个群或 Bot。',
        connected: `已连接，现在可以和 ${values.target} 说话了。`,
        stopped: '已停下。',
        idle: '现在没有在做的活。',
        stale: '这张卡已经答过了。',
        noFile: '这个文件发不过去，请在电脑上发。',
        noFileOut: `${values.name} 发不过来，请在电脑上打开。`,
        greeting: `你好，我是 ${values.name}。`,
        question: `${values.bot} 问你：`,
        approval: `${values.bot} 请你审批：`,
        secretAsk: `${values.bot} 要密钥 ${values.name}，请在电脑或手机 App 上填。`,
        viewShow: `${values.bot} 发了一个卡片，请在电脑或手机 App 上回复。`,
        answered: '已答',
        numbers: '回复编号',
        numbersMulti: '回复编号，多选用空格隔开',
        allow: '允许一次',
        reject: '拒绝',
      },
      'zh-TW': {
        requested: '已向 DS Bot 發出連線請求，請在電腦上的 DS Bot 設定 → IM 裡允許。',
        unbound: '這個 IM 機器人還沒綁定 Bot，請在 DS Bot 設定 → IM 裡選一個。',
        unboundGroup: '這個群還沒綁定，請在 DS Bot 設定 → IM 裡給它選一個群或 Bot。',
        connected: `已連線，現在可以和 ${values.target} 說話了。`,
        stopped: '已停下。',
        idle: '現在沒有在做的活。',
        stale: '這張卡已經答過了。',
        noFile: '這個檔案傳不過去，請在電腦上傳。',
        noFileOut: `${values.name} 傳不過來，請在電腦上開啟。`,
        greeting: `你好，我是 ${values.name}。`,
        question: `${values.bot} 問你：`,
        approval: `${values.bot} 請你審批：`,
        secretAsk: `${values.bot} 要金鑰 ${values.name}，請在電腦或手機 App 上填。`,
        viewShow: `${values.bot} 發了一個卡片，請在電腦或手機 App 上回覆。`,
        answered: '已答',
        numbers: '回覆編號',
        numbersMulti: '回覆編號，多選用空格隔開',
        allow: '允許一次',
        reject: '拒絕',
      },
      ja: {
        requested: 'DS Bot に接続リクエストを送信しました。PC の DS Bot 設定 → IM で許可してください。',
        unbound: 'この IM ボットはまだ Bot に紐付けられていません。DS Bot 設定 → IM で選択してください。',
        unboundGroup: 'このグループはまだ紐付けられていません。DS Bot 設定 → IM でグループまたは Bot を選択してください。',
        connected: `接続しました。${values.target} と話せます。`,
        stopped: '停止しました。',
        idle: '実行中のタスクはありません。',
        stale: 'このカードは回答済みです。',
        noFile: 'このファイルはここでは送信できません。PC から送信してください。',
        noFileOut: `${values.name} はここに送信できません。PC で開いてください。`,
        greeting: `こんにちは、${values.name} です。`,
        question: `${values.bot} からの質問：`,
        approval: `${values.bot} からの承認リクエスト：`,
        secretAsk: `${values.bot} がシークレット ${values.name} を必要としています。PC またはスマホアプリで入力してください。`,
        viewShow: `${values.bot} がカードを共有しました。PC またはスマホアプリで回答してください。`,
        answered: '回答済み',
        numbers: '番号を返信',
        numbersMulti: '番号をスペース区切りで返信',
        allow: '1回許可',
        reject: '拒否',
      },
      ko: {
        requested: 'DS Bot에 연결 요청을 보냈습니다. 컴퓨터의 DS Bot 설정 → IM에서 허용해 주세요.',
        unbound: '이 IM 봇은 아직 Bot에 연결되지 않았습니다. DS Bot 설정 → IM에서 선택해 주세요.',
        unboundGroup: '이 그룹은 아직 연결되지 않았습니다. DS Bot 설정 → IM에서 그룹이나 Bot을 선택해 주세요.',
        connected: `연결되었습니다. 이제 ${values.target}와(과) 대화할 수 있습니다.`,
        stopped: '중지되었습니다.',
        idle: '진행 중인 작업이 없습니다.',
        stale: '이미 응답한 카드입니다.',
        noFile: '이 파일은 여기서 보낼 수 없습니다. 컴퓨터에서 보내 주세요.',
        noFileOut: `${values.name} 파일은 여기로 보낼 수 없습니다. 컴퓨터에서 열어 주세요.`,
        greeting: `안녕하세요, ${values.name}입니다.`,
        question: `${values.bot}의 질문: `,
        approval: `${values.bot}의 승인 요청: `,
        secretAsk: `${values.bot}에서 시크릿 ${values.name}이(가) 필요합니다. 컴퓨터나 휴대폰 앱에서 입력해 주세요.`,
        viewShow: `${values.bot}에서 카드를 보냈습니다. 컴퓨터나 휴대폰 앱에서 응답해 주세요.`,
        answered: '응답함',
        numbers: '번호로 답장',
        numbersMulti: '공백으로 구분하여 번호로 답장',
        allow: '한 번 허용',
        reject: '거부',
      },
      es: {
        requested: 'Se envió una solicitud de conexión a DS Bot; permítela en Ajustes → IM en el ordenador.',
        unbound: 'Este bot de IM aún no está vinculado a un Bot; elige uno en Ajustes de DS Bot → IM.',
        unboundGroup: 'Este grupo aún no está vinculado; elige un grupo o un Bot en Ajustes de DS Bot → IM.',
        connected: `Conectado — ya puedes hablar con ${values.target}.`,
        stopped: 'Detenido.',
        idle: 'No hay nada en curso.',
        stale: 'Esta tarjeta ya fue respondida.',
        noFile: 'Este archivo no se puede enviar por aquí; envíalo desde el ordenador.',
        noFileOut: `${values.name} no se puede enviar por aquí; ábrelo en el ordenador.`,
        greeting: `Hola, soy ${values.name}.`,
        question: `${values.bot} pregunta: `,
        approval: `${values.bot} pide aprobación: `,
        secretAsk: `${values.bot} necesita la clave ${values.name} — rellénala en el ordenador o en la app móvil.`,
        viewShow: `${values.bot} compartió una tarjeta — respóndela en el ordenador o en la app móvil.`,
        answered: 'respondido',
        numbers: 'responde con el número',
        numbersMulti: 'responde con los números separados por espacios',
        allow: 'Permitir una vez',
        reject: 'Rechazar',
      },
      fr: {
        requested: 'Une demande de connexion a été envoyée à DS Bot ; autorisez-la dans Paramètres → IM sur l’ordinateur.',
        unbound: 'Ce bot IM n’est pas encore lié à un Bot ; choisissez-en un dans Paramètres DS Bot → IM.',
        unboundGroup: 'Ce groupe n’est pas encore lié ; choisissez un groupe ou un Bot dans Paramètres DS Bot → IM.',
        connected: `Connecté — vous pouvez maintenant parler à ${values.target}.`,
        stopped: 'Arrêté.',
        idle: 'Rien n’est en cours.',
        stale: 'Cette carte a déjà reçu une réponse.',
        noFile: 'Ce fichier ne peut pas être envoyé ici ; envoyez-le depuis l’ordinateur.',
        noFileOut: `${values.name} ne peut pas être envoyé ici ; ouvrez-le sur l’ordinateur.`,
        greeting: `Bonjour, je suis ${values.name}.`,
        question: `${values.bot} demande : `,
        approval: `${values.bot} demande une approbation : `,
        secretAsk: `${values.bot} a besoin de la clé ${values.name} — renseignez-la sur l’ordinateur ou l’application mobile.`,
        viewShow: `${values.bot} a partagé une carte — répondez-y sur l’ordinateur ou l’application mobile.`,
        answered: 'répondu',
        numbers: 'répondez avec le numéro',
        numbersMulti: 'répondez avec les numéros séparés par des espaces',
        allow: 'Autoriser une fois',
        reject: 'Refuser',
      },
      de: {
        requested: 'Eine Verbindungsanfrage wurde an DS Bot gesendet; erlaube sie am Computer unter Einstellungen → IM.',
        unbound: 'Dieser IM-Bot ist noch keinem Bot zugewiesen; wähle einen in den DS Bot-Einstellungen → IM.',
        unboundGroup: 'Diese Gruppe ist noch nicht zugewiesen; wähle eine Gruppe oder einen Bot in den DS Bot-Einstellungen → IM.',
        connected: `Verbunden — du kannst jetzt mit ${values.target} sprechen.`,
        stopped: 'Gestoppt.',
        idle: 'Aktuell läuft nichts.',
        stale: 'Diese Karte wurde bereits beantwortet.',
        noFile: 'Diese Datei kann hier nicht gesendet werden; sende sie am Computer.',
        noFileOut: `${values.name} kann hier nicht gesendet werden; öffne die Datei am Computer.`,
        greeting: `Hallo, ich bin ${values.name}.`,
        question: `${values.bot} fragt: `,
        approval: `${values.bot} bittet um Freigabe: `,
        secretAsk: `${values.bot} benötigt den Schlüssel ${values.name} — gib ihn am Computer oder in der Smartphone-App ein.`,
        viewShow: `${values.bot} hat eine Karte geteilt — beantworte sie am Computer oder in der Smartphone-App.`,
        answered: 'beantwortet',
        numbers: 'mit der Nummer antworten',
        numbersMulti: 'mit durch Leerzeichen getrennten Nummern antworten',
        allow: 'Einmal erlauben',
        reject: 'Ablehnen',
      },
    }
    return (table[lang] ?? table.en)[key] ?? key
  }

  const runtimes = new Map()
  const runtimeOf = async (id) => {
    let held = runtimes.get(id)
    if (held !== undefined) return held
    let data
    try {
      data = JSON.parse(await readFile(join(imDir, `${id}.json`), 'utf8'))
    } catch { data = undefined }
    held = {
      data: {
        runtime: data?.runtime !== null && typeof data?.runtime === 'object' ? data.runtime : {},
        cards: data?.cards !== null && typeof data?.cards === 'object' ? data.cards : {},
        pushed: data?.pushed !== null && typeof data?.pushed === 'object' ? data.pushed : {},
      },
      timer: undefined,
    }
    runtimes.set(id, held)
    return held
  }
  const scheduleWrite = (id) => {
    const held = runtimes.get(id)
    if (held === undefined || held.timer !== undefined) return
    held.timer = setTimeout(() => {
      held.timer = undefined
      void writeRuntime(id).catch(error => rt.warn('ds-bot: im runtime %s not saved: %s', id, error))
    }, RUNTIME_SAVE_MS)
    held.timer.unref?.()
  }
  const writeRuntime = async (id) => {
    const held = runtimes.get(id)
    if (held === undefined || rt.readOnly() !== undefined) return
    await mkdir(imDir, { recursive: true })
    const temp = join(imDir, `${id}.${process.pid}.tmp`)
    try {
      await writeFile(temp, JSON.stringify(held.data), { encoding: 'utf8', mode: 0o600 })
      await chmod(temp, 0o600)
      await replaceFile(temp, join(imDir, `${id}.json`))
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }
  const runtimeEnv = async (id) => {
    const held = await runtimeOf(id)
    return {
      get: () => held.data.runtime,
      set: (patch) => {
        Object.assign(held.data.runtime, patch)
        scheduleWrite(id)
      },
    }
  }
  const cardsOf = async (id) => (await runtimeOf(id)).data
  const markCard = async (id, cardKey, chatKey, messageId, body) => {
    const data = await cardsOf(id)
    const entries = data.cards[cardKey] ?? []
    const held = entries.find(entry => entry.chatKey === chatKey)
    if (held !== undefined) {
      held.messageId = messageId ?? held.messageId
      held.text = body ?? held.text
    } else {
      entries.push({ chatKey, messageId, text: body })
    }
    data.cards[cardKey] = entries
    scheduleWrite(id)
  }
  const unmarkCard = async (id, cardKey, chatKey) => {
    const data = await cardsOf(id)
    const entries = data.cards[cardKey]
    if (entries === undefined) return
    const kept = entries.filter(entry => entry.chatKey !== chatKey)
    if (kept.length === entries.length) return
    if (kept.length === 0) delete data.cards[cardKey]
    else data.cards[cardKey] = kept
    scheduleWrite(id)
  }
  const settleCard = async (id, cardKey, answer) => {
    const data = await cardsOf(id)
    const entries = data.cards[cardKey]
    if (entries === undefined) return
    for (const entry of entries) entry.answer ??= answer
    scheduleWrite(id)
  }

  const connections = (): Record<string, any> => (state.im ??= { connections: {} }).connections
  const adaptersFor = () => Object.keys(adapters)
  const hasSecrets = conn => Object.values(conn.secrets ?? {}).every(name => rt.secretValue(name) !== undefined)
  const fieldsOf = (conn) => {
    const fields = { ...conn.settings }
    for (const [key, name] of Object.entries(conn.secrets ?? {})) fields[key] = rt.secretValue(name)
    return fields
  }
  const reasonOf = (error) => {
    const parts = []
    for (let at = error, depth = 0; at !== undefined && at !== null && depth < 4; at = at.cause, depth += 1) {
      const text = typeof at === 'string' ? at : at?.message
      if (typeof text === 'string' && text.trim() !== '' && !parts.includes(text.trim())) parts.push(text.trim())
    }
    return parts.length === 0 ? 'The connection failed' : parts.join(': ')
  }

  // The reason can quote the request URL, and a platform URL carries the token:
  // keep the secret field values, also as they appear in a URL, out of the text before it
  // reaches the UI or the log.
  const scrub = (text, fields, platform) => {
    let out = text
    for (const field of platform.fields) {
      const value = fields[field.key]
      if (!field.secret || typeof value !== 'string' || value.length < 4) continue
      for (const form of new Set([value, encodeURIComponent(value)])) out = out.split(form).join('***')
    }
    return out
  }
  const checkAccount = async (platform, fields, env) => {
    try {
      return await adapters[platform.id].check(fields, env)
    } catch (error) {
      throw new Error(scrub(rt.redactSecrets(reasonOf(error)), fields, platform))
    }
  }

  const envFor = async (conn, runtime?) => ({
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    config: rt.config.im?.[conn.platform],
    runtime: runtime ?? await runtimeEnv(conn.id),
    log: { warn: (template, ...args) => rt.warn(template, ...args) },
    uploadFile: async (sessionId, file) => {
      const uploads = ctx.get?.('fileUploads')
      if (typeof uploads?.uploadStream !== 'function') throw new Error('no upload service')
      const data = file.data?.[Symbol.asyncIterator] !== undefined ? file.data : (async function* () { yield file.data })()
      const value = await uploads.uploadStream({ sessionId, data, name: file.name })
      return value.receiptId
    },
  })

  const runners = new Map()
  const statuses = new Map()
  let stopped = false

  const readPresented = async (path, limit) => {
    if (!isAbsolute(path) || await rt.inData?.(await rt.real(path))) return undefined
    let handle
    try {
      // O_NONBLOCK keeps a FIFO from stalling the chat's queue on open.
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      const info = await handle.stat()
      if (!info.isFile() || info.size > limit) return undefined
      const data = await handle.readFile()
      return data.length > limit ? undefined : data
    } catch {
      return undefined
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  const outbox = createImOutbox({
    isLive: id => connections()[id] !== undefined,
    isStopped: () => stopped,
    redact: value => rt.redactSecrets(value),
    warn: (template, ...args) => rt.warn(template, ...args),
    readFile: readPresented,
    unavailableFileText: name => text('noFileOut', { name }),
  })

  const setStatus = (id, next) => {
    // Adapter errors can echo platform responses that quote the token; keep them out of the UI and logs.
    if (typeof next.error === 'string' && next.error !== '') return statuses.set(id, { ...next, error: rt.redactSecrets(next.error), at: Date.now() })
    return statuses.set(id, { ...next, at: Date.now() })
  }
  const targetsOf = (conn) => {
    const out = []
    for (const [chatKey, chat] of Object.entries(conn.chats ?? {}) as [string, any][]) {
      const target = chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
      out.push({ chatKey, chat, target })
    }
    return out
  }

  const paired = (conn, senderId) => (conn.paired ?? []).some(entry => entry.id === senderId)

  const bindingOf = (conn, chatKey) => {
    const chat = conn?.chats?.[chatKey]
    if (chat === undefined) return undefined
    const target = chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
    if (target?.botId !== undefined && rt.botOf(target.botId) !== undefined) return `bot:${target.botId}`
    if (target?.roomId !== undefined && rt.roomOf(target.roomId) !== undefined) return `room:${target.roomId}`
    return undefined
  }
  const chatOfBot = botId => rt.botOf(botId) === undefined ? undefined : rt.chatOf(botId)
  const origin = createReplyOrigin({
    connections, runners, paired, bindingOf, chatOfBot,
    savedCarries: create => create ? (state.imReplyOrigins ??= {}) : state.imReplyOrigins,
    save: () => rt.save({ required: true }),
    warn: rt.warn,
    botOfSession: id => rt.botOf(rt.selfOf(id))?.id,
    roomOf: rt.roomOf,
    roomWorking: id => rt.roomActive?.(id) || (rt.roomWorkView?.()[id] ?? []).length > 0,
    isBotChat: id => rt.chatOwners.has(id),
    sessionExists: id => rt.chatOwners.has(id) || rt.groupOwners.has(id) || rt.pastOwners.has(id) || rt.roomOf(id) !== undefined,
  })
  const stopWatchingSessions = rt.onSessionIdentityChange?.(origin.prune)

  const enqueue = (conn, chatKey, job) => outbox.enqueue(conn.id, chatKey, job)

  const rememberPush = async (id, messageId, entry) => {
    if (messageId === undefined || messageId === null) return
    const data = (await runtimeOf(id)).data
    data.pushed[String(messageId)] = { ...entry, at: Date.now() }
    const keys = Object.keys(data.pushed)
    if (keys.length > PUSHED_MAX) {
      for (const key of keys.sort((a, b) => data.pushed[a].at - data.pushed[b].at).slice(0, keys.length - PUSHED_MAX)) delete data.pushed[key]
    }
    scheduleWrite(id)
  }
  const imPush = async ({ text: body, cardId, botId }) => {
    const main = rt.state.mainBotIds?.[0]
    if (main === undefined || rt.botOf(main) === undefined) return 0
    let sent = 0
    for (const conn of Object.values(connections())) {
      if (!runners.has(conn.id)) continue
      for (const { chatKey, chat, target } of targetsOf(conn)) {
        if (chat.kind !== 'direct' || target?.botId !== main) continue
        sent += 1
        const after = cardId === undefined ? undefined : (done) => { void rememberPush(conn.id, done?.messageId, { cardId, ...(botId === undefined ? {} : { botId }) }) }
        sendTo(conn, chatKey, { key: chatKey, kind: chat.kind, title: chat.title }, body, undefined, after)
      }
    }
    return sent
  }
  const replyToPush = async (conn, msg, body) => {
    if (msg.replyTo === undefined || msg.replyTo === null || body === '') return false
    const pushed = (await runtimeOf(conn.id)).data.pushed[String(msg.replyTo)]
    if (pushed === undefined) return false
    const requestId = `im:${conn.platform}:${randomUUID()}`
    origin.rememberRequest(requestId, conn, msg.chat.key, msg.sender.id)
    if (await rt.cardNote?.({ cardId: pushed.cardId, text: body, requestId }) === true) return true
    const thread = rt.cardSession?.(pushed.botId, pushed.cardId)
    if (thread !== undefined) {
      await rt.dispatch.sendUser({ sessionId: thread, content: [{ type: 'text', text: body }], requestId })
      return true
    }
    origin.forgetRequest(requestId)
    return pushed
  }

  const sendText = (conn, chat, body, buttons?, after?) => enqueue(conn, chat.key, { chat, text: body, buttons, after })
  const sendTo = (conn, chatKey, chat, body, buttons?, after?) => enqueue(conn, chatKey, { chat, text: body, buttons, after })

  const requested = (conn, msg) => {
    if ((conn.requests ?? []).some(entry => entry.id === msg.sender.id)) return false
    conn.requests = [...(conn.requests ?? []), { id: msg.sender.id, name: msg.sender.name, chatKey: msg.chat.key, chatKind: msg.chat.kind, at: Date.now() }]
    return true
  }

  const targetName = (conn, target) => {
    if (target?.botId !== undefined) return rt.botOf(target.botId)?.name
    if (target?.roomId !== undefined) return rt.roomOf(target.roomId)?.name
    return undefined
  }
  const resolveTarget = (conn, chat) => {
    const target = chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
    if (target?.botId !== undefined && rt.botOf(target.botId) !== undefined) return target
    if (target?.roomId !== undefined && rt.roomOf(target.roomId) !== undefined) return target
    return undefined
  }

  const openCard = (conn, chatKey, cardKey) => {
    const entries = runtimes.get(conn.id)?.data?.cards[cardKey]
    const entry = entries?.find(item => item.chatKey === chatKey && item.answer === undefined)
    return entry === undefined ? undefined : { cardKey, entry }
  }
  const questionById = (id) => {
    for (const [sessionId, question] of Object.entries(state.questions ?? {}) as [string, any][]) {
      if (question.id === id) return { sessionId, question }
    }
    return undefined
  }
  const answerQuestionCard = async (conn, chat, cardKey, labels, senderId) => {
    const held = openCard(conn, chat.key, cardKey)
    if (held === undefined) return false
    const found = questionById(held.cardKey.slice(2))
    if (found === undefined) {
      await sendCardReply(conn, chat, text('stale'))
      return 'stale'
    }
    if (questionsOf(found.question).length > 1) return false
    const valid = labels.filter(label => (found.question.options ?? []).some(option => option.label === label))
    if (valid.length === 0) return false
    const requestId = `im:${conn.platform}:${randomUUID()}`
    origin.rememberRequest(requestId, conn, chat.key, senderId)
    try {
      await rt.answerQuestion(found.sessionId, found.question.id, { selected: valid }, requestId)
      await settleCard(conn.id, held.cardKey, valid.join(', '))
      await settledEdits(conn)
    } catch (error) {
      origin.forgetRequest(requestId)
      if (error?.code === 'bot/stale') {
        await settleCard(conn.id, held.cardKey, text('answered'))
        await sendCardReply(conn, chat, text('stale'))
        await settledEdits(conn)
        return 'stale'
      }
      throw error
    }
    return 'answered'
  }
  const answerApprovalCard = async (conn, chat, cardKey, choice) => {
    const held = openCard(conn, chat.key, cardKey)
    if (held === undefined) return false
    try {
      rt.answerApproval(held.cardKey.slice(2), choice)
      await settleCard(conn.id, held.cardKey, choice === 'allow' ? text('allow') : text('reject'))
      await settledEdits(conn)
    } catch (error) {
      if (error?.code === 'bot/stale') {
        await sendCardReply(conn, chat, text('stale'))
        return 'stale'
      }
      throw error
    }
    return 'answered'
  }
  const sendCardReply = async (conn, chat, body) => sendText(conn, { key: chat.key, kind: chat.kind, title: chat.title }, body)

  const newestOpenCard = (conn, chatKey) => {
    const data = runtimes.get(conn.id)?.data
    if (data === undefined) return undefined
    for (const [cardKey, entries] of (Object.entries(data.cards) as [string, any[]][]).reverse()) {
      if (!cardKey.startsWith('q:') && !cardKey.startsWith('a:')) continue
      const entry = entries.find(item => item.chatKey === chatKey && item.answer === undefined)
      if (entry !== undefined) return { cardKey, entry }
    }
    return undefined
  }

  const onMessage = (conn) => async (msg) => {
    if (!paired(conn, msg.sender.id)) {
      if (msg.chat.kind === 'group' && !msg.mentioned) return
      if (!requested(conn, msg)) return
      await rt.save()
      await sendText(conn, msg.chat, text('requested'))
      return
    }
    conn.chats ??= {}
    if (msg.chat.kind === 'group' && !msg.mentioned) return
    if (conn.chats[msg.chat.key] === undefined) {
      conn.chats[msg.chat.key] = { kind: msg.chat.kind, title: msg.chat.title, at: Date.now() }
      await rt.save()
    }
    const body = String(msg.text ?? '').trim()
    const chat = conn.chats[msg.chat.key]
    const target = resolveTarget(conn, chat)
    if (/^\/start(?:@\S+)?\s*$/.test(body)) {
      const name = target === undefined ? undefined : targetName(conn, target)
      await sendText(conn, msg.chat, name === undefined ? text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound') : text('greeting', { name }))
      return
    }
    if (/^\/stop(?:@\S+)?\s*$/.test(body)) {
      if (target === undefined) {
        await sendText(conn, msg.chat, text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound'))
        return
      }
      const stopped = target.botId !== undefined ? await rt.stopChat(target.botId) : await rt.stopRoomWork(target.roomId)
      await sendText(conn, msg.chat, text(stopped ? 'stopped' : 'idle'))
      return
    }
    const aboutCard = await replyToPush(conn, msg, body)
    if (aboutCard === true) return
    if (NUMBERS.test(body)) {
      const picked = body.trim().split(/\s+/).map(Number)
      const held = newestOpenCard(conn, msg.chat.key)
      if (held !== undefined && held.cardKey.startsWith('q:')) {
        const found = questionById(held.cardKey.slice(2))
        if (found !== undefined) {
          const options = found.question.options ?? []
          const inRange = picked.length > 0 && (found.question.multiSelect === true || picked.length === 1)
            && picked.every(index => options[index - 1] !== undefined)
          if (inRange) {
            const answered = await answerQuestionCard(conn, msg.chat, held.cardKey, picked.map(index => options[index - 1].label), msg.sender.id)
            if (answered !== false) return
          }
        }
      } else if (held !== undefined && held.cardKey.startsWith('a:')
        && picked.length === 1 && (picked[0] === 1 || picked[0] === 2)
        && rt.approvalsView().some(entry => `a:${entry.id}` === held.cardKey)) {
        const answered = await answerApprovalCard(conn, msg.chat, held.cardKey, picked[0] === 1 ? 'allow' : 'reject')
        if (answered === 'answered') origin.claimChat(conn, msg.chat, msg.sender.id)
        if (answered !== false) return
      }
    }
    if (target === undefined) {
      await sendText(conn, msg.chat, text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound'))
      return
    }
    const sessionId = target.botId ?? target.roomId
    // The receipt has to sit on the Session that takes the message. A group's own
    // Session moves on to a fresh part (`room.sessionId`) while `room.id` stays the
    // first one, so uploading under the id leaves the receipt on a Session the
    // message never reaches and DSH drops the file (#1121).
    const uploadTo = target.botId !== undefined
      ? rt.chatOf(target.botId)
      : rt.sessionOfRoom(rt.roomOf(target.roomId))
    const content = []
    if (body !== '') content.push({ type: 'text', text: aboutCard === false ? body : `[A reply to your message about card ${aboutCard.cardId}] ${body}` })
    for (const image of msg.images ?? []) content.push({ type: 'image', mediaType: image.mediaType, data: image.data })
    const env = await envFor(conn)
    for (const file of msg.files ?? []) {
      try {
        const receiptId = await env.uploadFile(uploadTo, file)
        content.push({ type: 'file', receiptId })
      } catch {
        await sendText(conn, msg.chat, text('noFile'))
      }
    }
    if (content.length === 0) return
    const requestId = `im:${conn.platform}:${randomUUID()}`
    origin.rememberRequest(requestId, conn, msg.chat.key, msg.sender.id)
    await rt.dispatch.sendUser({ sessionId, content, requestId })
  }

  const onAction = (conn) => async (action) => {
    if (!paired(conn, action.sender.id)) return
    const data = String(action.data ?? '')
    const chat = { key: action.chat.key, kind: action.chat.kind, title: action.chat.title }
    const cut = data.lastIndexOf(':')
    const cardKey = data.slice(0, cut)
    const choice = data.slice(cut + 1)
    if (data.startsWith('q:') && cut > 2) {
      const found = questionById(cardKey.slice(2))
      const label = found?.question.options?.[Number(choice)]?.label
      if (label === undefined) {
        await sendCardReply(conn, chat, text('stale'))
        return
      }
      const answered = await answerQuestionCard(conn, chat, cardKey, [label], action.sender.id)
      if (answered === false) await sendCardReply(conn, chat, text('stale'))
      return
    }
    if (data.startsWith('a:') && cut > 2) {
      if (choice === 'allow' || choice === 'reject') {
        const answered = await answerApprovalCard(conn, chat, cardKey, choice)
        if (answered === 'answered') origin.claimChat(conn, chat, action.sender.id)
        else if (answered === false) await sendCardReply(conn, chat, text('stale'))
      }
    }
  }

  const cardText = {
    question: (bot, question) => {
      const asked = questionsOf(question)
      if (asked.length > 1) {
        return [text('viewShow', { bot }), ...asked.map((item, index) => `${index + 1}. ${questionTitle(item)} — ${(item.options ?? []).map(option => option.label).join(' / ')}`)].join('\n')
      }
      const options = (question.options ?? []).map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n')
      const hint = question.multiSelect === true ? text('numbersMulti') : text('numbers')
      return `${text('question', { bot })}${question.question}${question.detail ? `\n${question.detail}` : ''}\n${options}\n(${hint})`
    },
    approval: (bot, entry) => `${text('approval', { bot })}${entry.tool}${entry.reason ? ` — ${entry.reason}` : ''}${entry.detail?.text ? `\n${entry.detail.text}` : ''}${entry.detail?.code ? `\n${entry.detail.code}` : ''}`,
  }
  const cardButtons = {
    question: (question) => (question.multiSelect === true || questionsOf(question).length > 1 ? undefined : (question.options ?? []).map((option, index) => ({ data: `q:${question.id}:${index}`, label: option.label }))),
    approval: (id) => [{ data: `a:${id}:allow`, label: text('allow') }, { data: `a:${id}:reject`, label: text('reject') }],
  }

  const sendCard = async (conn, cardKey, targets, body, buttons?) => {
    const data = await cardsOf(conn.id)
    if (!runners.has(conn.id)) return
    const entries = data.cards[cardKey] ??= []
    const recorded = new Set(entries.map(entry => entry.chatKey))
    const pending = targets.filter(({ chatKey }) => !recorded.has(chatKey))
    if (pending.length === 0) return
    for (const { chatKey } of pending) entries.push({ chatKey, messageId: undefined, text: body })
    scheduleWrite(conn.id)
    for (const { chatKey, chat, canSend } of pending) {
      enqueue(conn, chatKey, {
        chat: { key: chatKey, kind: chat.kind, title: chat.title },
        text: body,
        buttons,
        canSend,
        after: (sent) => { void markCard(conn.id, cardKey, chatKey, sent?.messageId, body) },
        onDrop: () => unmarkCard(conn.id, cardKey, chatKey),
      })
    }
  }

  const diffCards = async () => {
    if (rt.readOnly() !== undefined) return
    for (const conn of Object.values(connections())) {
      const runner = runners.get(conn.id)
      if (runner === undefined) continue
      await cardsOf(conn.id)
      for (const [sessionId, question] of Object.entries(state.questions ?? {}) as [string, any][]) {
        const cardKey = `q:${question.id}`
        const botId = rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        const reply = origin.deliveryOf(sessionId)
        if (reply === undefined || reply.conn.id !== conn.id) continue
        const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.question(question) : undefined
        await sendCard(conn, cardKey, [reply], cardText.question(bot.name, question), buttons)
      }
      for (const entry of rt.approvalsView?.() ?? []) {
        const cardKey = `a:${entry.id}`
        const bot = rt.botOf(entry.botId)
        const reply = origin.deliveryOf(entry.roomId !== undefined ? (rt.roomOf(entry.roomId)?.sessionId ?? entry.roomId) : chatOfBot(entry.botId))
        if (reply === undefined || reply.conn.id !== conn.id) continue
        const targets = [reply]
        const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.approval(entry.id) : undefined
        await sendCard(conn, cardKey, targets, cardText.approval(bot?.name ?? '?', entry), buttons)
      }
      for (const [botId, list] of Object.entries(state.secretRequests ?? {}) as [string, any[]][]) {
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        for (const request of list) {
          const cardKey = `s:${request.id}`
          if (request.status !== 'pending') continue
          const reply = origin.deliveryOf(chatOfBot(botId))
          if (reply === undefined || reply.conn.id !== conn.id) continue
          await sendCard(conn, cardKey, [reply], text('secretAsk', { bot: bot.name, name: request.name }))
        }
      }
      for (const [sessionId, view] of Object.entries(state.views ?? {}) as [string, any][]) {
        const cardKey = `v:${view.id}`
        const botId = rt.chatOwners.get(sessionId)
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        const reply = origin.deliveryOf(sessionId)
        if (reply === undefined || reply.conn.id !== conn.id) continue
        const form = viewCardText({ title: view.title, view: view.view })
        await sendCard(conn, cardKey, [reply], `${text('viewShow', { bot: bot.name })}${form !== '' ? `\n${form}` : view.title ? `\n${view.title}` : ''}`)
      }
    }
  }

  const settledEdits = async (conn) => {
    const runner = runners.get(conn.id)
    const data = runtimes.get(conn.id)?.data
    if (runner?.handle.edit === undefined || data === undefined) return
    for (const entries of Object.values(data.cards) as any[][]) {
      for (const entry of entries) {
        if (entry.answer === undefined || entry.messageId === undefined || entry.edited === true) continue
        const chat = conn.chats?.[entry.chatKey]
        if (chat === undefined) continue
        entry.edited = true
        const body = entry.text !== undefined ? `${entry.text}\n— ${entry.answer}` : `(${text('answered')})`
        runner.handle.edit({ key: entry.chatKey, kind: chat.kind, title: chat.title }, entry.messageId, { text: body }).catch(() => {})
        scheduleWrite(conn.id)
      }
    }
  }
  const settleGone = async () => {
    for (const conn of Object.values(connections())) {
      const data = runtimes.get(conn.id)?.data
      if (data === undefined) continue
      let touched = false
      const openIds = new Set((Object.values(state.questions ?? {}) as any[]).map(question => `q:${question.id}`))
      const openSecret = new Set((Object.values(state.secretRequests ?? {}) as any[][]).flat().filter(entry => entry.status === 'pending').map(entry => `s:${entry.id}`))
      const openViews = new Set((Object.values(state.views ?? {}) as any[]).map(view => `v:${view.id}`))
      const openCard = cardKey => cardKey.startsWith('q:') ? openIds.has(cardKey)
        : cardKey.startsWith('a:') ? rt.approvalsView().some(entry => `a:${entry.id}` === cardKey)
          : cardKey.startsWith('s:') ? openSecret.has(cardKey)
            : cardKey.startsWith('v:') ? openViews.has(cardKey) : false
      for (const [cardKey, entries] of Object.entries(data.cards) as [string, any[]][]) {
        if (openCard(cardKey)) continue
        for (const entry of entries) {
          if (entry.answer === undefined) {
            entry.answer = text('answered')
            touched = true
          }
        }
      }
      if (touched) {
        scheduleWrite(conn.id)
        await settledEdits(conn)
      }
      const editable = runners.get(conn.id)?.handle?.edit !== undefined
      let pruned = false
      for (const [cardKey, entries] of Object.entries(data.cards) as [string, any[]][]) {
        if (openCard(cardKey)) continue
        const droppable = entries.length === 0 || entries.every(entry => entry.answer !== undefined
          && (entry.edited === true || entry.messageId === undefined || !editable || conn.chats?.[entry.chatKey] === undefined))
        if (droppable) {
          delete data.cards[cardKey]
          pruned = true
        }
      }
      if (pruned) scheduleWrite(conn.id)
    }
  }

  const fresh = id => connections()[id]
  const onStatus = (id) => (next) => {
    setStatus(id, { state: next.state, error: next.error, at: Date.now() })
    const conn = fresh(id)
    if (conn !== undefined && next.account !== undefined && (conn.account?.id !== next.account.id || conn.account?.name !== next.account.name)) {
      conn.account = next.account
      void rt.save().catch(() => {})
    }
  }

  const busyOf = (target) => {
    if (target?.botId !== undefined) return rt.live.get(rt.chatOf(target.botId))?.turn !== undefined
    if (target?.roomId !== undefined) return (rt.roomWorkView?.()[target.roomId] ?? []).length > 0
    return false
  }

  const start = async (conn) => {
    const adapter = adapters[conn.platform]
    if (adapter === undefined || runners.has(conn.id)) return
    const platform = imPlatform(conn.platform)
    if ((platform as any)?.ws === true && globalThis.WebSocket === undefined) {
      setStatus(conn.id, { state: 'error', error: 'This dsh runs on a Node without WebSocket', at: Date.now() })
      return
    }
    const runner = { handle: undefined, typing: undefined }
    runners.set(conn.id, runner)
    const token = outbox.open(conn.id)
    setStatus(conn.id, { state: 'connecting', at: Date.now() })
    try {
      const env = await envFor(conn)
      const handle = adapter.connect(fieldsOf(conn), env, {
        onMessage: (msg) => {
          const current = fresh(conn.id)
          return current === undefined ? undefined : onMessage(current)(msg).catch(error => rt.warn('ds-bot: im message failed: %s', error))
        },
        onAction: (action) => {
          const current = fresh(conn.id)
          return current === undefined ? undefined : onAction(current)(action).catch(error => rt.warn('ds-bot: im action failed: %s', error))
        },
        onStatus: onStatus(conn.id),
      })
      if (runners.get(conn.id) !== runner) {
        void Promise.resolve(handle?.stop?.()).catch(() => {})
        return
      }
      runner.handle = handle
      outbox.ready(conn.id, token, handle)
      if (typeof runner.handle?.typing === 'function') {
        runner.typing = setInterval(() => {
          for (const { chatKey, chat, target } of targetsOf(fresh(conn.id) ?? conn)) {
            if (target !== undefined && busyOf(target)) void runner.handle.typing({ key: chat.key ?? chatKey, kind: chat.kind, title: chat.title }).catch?.(() => {})
          }
        }, TYPING_MS)
        runner.typing.unref?.()
      }
      await diffCards()
    } catch (error) {
      runners.delete(conn.id)
      await outbox.abortOpen(conn.id, token)
      setStatus(conn.id, { state: 'error', error: String(error?.message ?? error).slice(0, 300), at: Date.now() })
    }
  }
  const stop = async (id) => {
    const runner = runners.get(id)
    runners.delete(id)
    const dropOnly = stopped || connections()[id] === undefined
    if (runner === undefined) {
      await outbox.detach(id, { dropOnly: true })
      if (statuses.get(id)?.state !== 'error') setStatus(id, { state: 'off', at: Date.now() })
      return
    }
    if (runner.typing !== undefined) clearInterval(runner.typing)
    await outbox.detach(id, { dropOnly })
    await Promise.resolve(runner.handle?.stop?.()).catch(() => {})
    if (statuses.get(id)?.state !== 'error') setStatus(id, { state: 'off', at: Date.now() })
  }

  let syncing = Promise.resolve()
  const sync = () => {
    const run = syncing.then(async () => {
      const conns = connections()
      for (const conn of Object.values(conns)) {
        const wants = stopped !== true && adapters[conn.platform] !== undefined && conn.enabled !== false
          && rt.readOnly() === undefined && hasSecrets(conn)
        if (wants && !runners.has(conn.id)) await start(conn)
        else if (!wants && runners.has(conn.id)) await stop(conn.id)
      }
      for (const id of [...runners.keys()]) if (conns[id] === undefined) await stop(id)
      for (const id of [...statuses.keys()]) if (conns[id] === undefined) { statuses.delete(id); outbox.remove(id) }
      for (const conn of Object.values(conns)) {
        if (conn.enabled === false || !runners.has(conn.id)) {
          if (statuses.get(conn.id)?.state !== 'error') setStatus(conn.id, { state: 'off', at: Date.now() })
        }
      }
      await diffCards()
    })
    syncing = run.catch(() => {})
    return run
  }

  const secretName = (conn, key) => `IM_${conn.platform.toUpperCase()}_${conn.id.slice(3, 9).toUpperCase()}_${secretField(key)}`
  const cleanFields = (platform, fields, base = {}) => {
    const given = fields !== null && typeof fields === 'object' ? fields : {}
    const out = {}
    for (const field of platform.fields) {
      const value = given[field.key]
      if (field.options !== undefined) {
        out[field.key] = field.options.some(([id]) => id === value) ? value
          : (value === undefined && base[field.key] !== undefined ? base[field.key] : field.options[0][0])
      } else if (typeof value === 'string' && value.trim() !== '') {
        out[field.key] = value.trim()
      } else if (!field.secret) {
        if (value !== undefined && typeof value !== 'string') throw new Error(`${field.label} must be text`)
        out[field.key] = value === undefined && base[field.key] !== undefined ? base[field.key] : ''
      }
      // Missing secret fields are allowed only on update, where the saved one stays.
    }
    return out
  }

  const saveSecrets = async (conn, platform, fields) => {
    for (const field of platform.fields) {
      if (!field.secret || fields[field.key] === undefined) continue
      const name = conn.secrets[field.key] ?? secretName(conn, field.key)
      await rt.secretEndpoint('secret-set', { name, value: fields[field.key], purpose: `${platform.name} IM bot`, scope: [] })
      conn.secrets[field.key] = name
    }
  }

  const viewOf = (conn) => ({
    id: conn.id,
    platform: conn.platform,
    account: conn.account ?? null,
    botId: conn.botId ?? null,
    settings: conn.settings ?? {},
    secrets: Object.keys(conn.secrets ?? {}),
    enabled: conn.enabled !== false,
    paired: conn.paired ?? [],
    requests: conn.requests ?? [],
    chats: Object.fromEntries((Object.entries(conn.chats ?? {}) as [string, any][]).map(([key, chat]) => [key, { ...chat }])),
    createdAt: conn.createdAt,
  })

  const endpoints = {
    async 'im-add'(body) {
      const platform = imPlatform(String(body.platform ?? ''))
      if (platform === undefined || adapters[platform.id] === undefined) throw new Error('This platform is not available yet')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      if (platform.login === 'qr') throw new Error('This platform signs in by scanning a code; not available yet')
      const fields = cleanFields(platform, body.fields)
      for (const field of platform.fields) {
        if (!field.options && (fields[field.key] === undefined || String(fields[field.key]).trim() === '')) throw new Error(`${field.label} is required`)
      }
      const env = await envFor({ id: 'im_check', platform: platform.id, settings: fields, secrets: {} }, { get: () => ({}), set: () => {} })
      const { account } = await checkAccount(platform, fields, env)
      const conn = {
        id: `im_${randomBytes(4).toString('hex')}`,
        platform: platform.id,
        account,
        botId: bot.id,
        settings: Object.fromEntries(platform.fields.filter(field => !field.secret).map(field => [field.key, fields[field.key]])),
        secrets: {},
        enabled: true,
        paired: [],
        requests: [],
        chats: {},
        createdAt: Date.now(),
      }
      await saveSecrets(conn, platform, fields)
      connections()[conn.id] = conn
      await rt.save()
      await sync()
      return viewOf(conn)
    },
    async 'im-update'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const platform = imPlatform(conn.platform)
      if (platform === undefined) throw new Error('No such platform')
      if (body.botId !== undefined) {
        const bot = rt.botOf(String(body.botId))
        if (bot === undefined) throw new Error('Choose a Bot first')
        conn.botId = bot.id
      }
      if (body.enabled !== undefined) conn.enabled = body.enabled === true
      if (body.fields !== undefined) {
        const fields = cleanFields(platform, body.fields, conn.settings)
        const env = await envFor(conn)
        const check = { ...fields }
        for (const field of platform.fields) {
          if (field.secret && check[field.key] === undefined) check[field.key] = rt.secretValue(conn.secrets[field.key])
        }
        const { account } = await checkAccount(platform, check, env)
        conn.account = account
        await saveSecrets(conn, platform, fields)
        for (const field of platform.fields) {
          if (!field.secret && fields[field.key] !== undefined) conn.settings[field.key] = fields[field.key]
        }
      }
      await rt.save()
      if (runners.has(conn.id)) await stop(conn.id)
      await sync()
      return viewOf(conn)
    },
    async 'im-remove'(body) {
      const id = String(body.id ?? '')
      const conn = connections()[id]
      if (conn === undefined) throw new Error('No such IM bot')
      await stop(id)
      for (const name of Object.values(conn.secrets ?? {})) {
        await rt.secretEndpoint('secret-delete', { name }).catch(() => {})
      }
      delete connections()[id]
      outbox.remove(id)
      runtimes.delete(id)
      await rm(join(imDir, `${id}.json`), { force: true }).catch(() => {})
      await rt.save()
      return true
    },
    async 'im-pair'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const at = (conn.requests ?? []).findIndex(entry => entry.id === String(body.senderId ?? ''))
      if (at === -1) throw new Error('This request is gone')
      const [request] = conn.requests.splice(at, 1)
      if (body.allow === true) {
        conn.paired = [...(conn.paired ?? []), { id: request.id, name: request.name, at: Date.now() }]
        conn.chats ??= {}
        conn.chats[request.chatKey] ??= { kind: request.chatKind, title: request.name, at: Date.now() }
        await rt.save()
        const chat = conn.chats[request.chatKey]
        const target = resolveTarget(conn, chat)
        const name = target === undefined ? undefined : targetName(conn, target)
        await sendTo(conn, request.chatKey, { key: request.chatKey, kind: request.chatKind, title: chat.title },
          name === undefined ? text(request.chatKind === 'group' ? 'unboundGroup' : 'unbound') : text('connected', { target: name }))
      } else {
        await rt.save()
      }
      return true
    },
    async 'im-unpair'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      conn.paired = (conn.paired ?? []).filter(entry => entry.id !== String(body.senderId ?? ''))
      await rt.save()
      return true
    },
    async 'im-chat'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const chat = conn.chats?.[String(body.chatKey ?? '')]
      if (chat === undefined) throw new Error('No such chat')
      if (body.remove === true) {
        delete conn.chats[String(body.chatKey ?? '')]
      } else if (body.target === null) {
        delete chat.target
      } else if (body.target !== undefined) {
        const target = body.target
        if (target.botId !== undefined && rt.botOf(target.botId) === undefined) throw new Error('Choose a Bot or a group')
        if (target.roomId !== undefined && rt.roomOf(target.roomId) === undefined) throw new Error('Choose a Bot or a group')
        chat.target = target.botId !== undefined ? { botId: String(target.botId) } : { roomId: String(target.roomId) }
      }
      await rt.save()
      return true
    },
    async 'im-retry'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      if (statuses.get(conn.id)?.state !== 'ready') {
        if (runners.has(conn.id)) await stop(conn.id)
        await sync()
      }
      if (!runners.has(conn.id)) return true
      outbox.retry(conn.id)
      return true
    },
    async 'im-login-start'(body) {
      const platform = imPlatform(String(body.platform ?? ''))
      const adapter = platform === undefined ? undefined : adapters[platform.id]
      if (platform === undefined || typeof adapter?.loginStart !== 'function') throw new Error('This platform has no QR login')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      const env = await envFor({ id: 'im_login', platform: platform.id, settings: {}, secrets: {} }, { get: () => ({}), set: () => {} })
      const login = await adapter.loginStart(env)
      return { loginId: login.loginId, qr: login.qr, expiresAt: login.expiresAt, botId: bot.id }
    },
    async 'im-login-wait'(body) {
      const platform = imPlatform(String(body.platform ?? 'weixin'))
      const adapter = platform === undefined ? undefined : adapters[platform.id]
      if (platform === undefined || typeof adapter?.loginWait !== 'function') throw new Error('This platform has no QR login')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      const env = await envFor({ id: 'im_login', platform: platform.id, settings: {}, secrets: {} }, { get: () => ({}), set: () => {} })
      const login = await adapter.loginWait(String(body.loginId ?? ''), env)
      if (login.status !== 'done') return { status: login.status }
      const conn = {
        id: `im_${randomBytes(4).toString('hex')}`,
        platform: platform.id,
        account: login.connection.account,
        botId: bot.id,
        settings: login.connection.settings ?? {},
        secrets: {},
        enabled: true,
        paired: login.owner === undefined ? [] : [{ id: login.owner.id, name: login.owner.name, at: Date.now() }],
        requests: [],
        chats: login.owner === undefined ? {} : { [login.owner.id]: { kind: 'direct', title: login.owner.name, at: Date.now() } },
        createdAt: Date.now(),
      }
      for (const [key, value] of Object.entries(login.connection.secrets ?? {})) {
        const name = secretName(conn, key)
        await rt.secretEndpoint('secret-set', { name, value, purpose: `${platform.name} IM bot`, scope: [] })
        conn.secrets[key] = name
      }
      connections()[conn.id] = conn
      await rt.save()
      await sync()
      return { status: 'done', id: conn.id }
    },
  }

  const imEndpoint = async (endpoint, body) => {
    const result = await endpoints[endpoint]?.(body ?? {})
    if (result === undefined) throw new Error(`Unknown endpoint ${endpoint}`)
    if (endpoint !== 'im-retry') void sync()
    void diffCards()
    return result
  }

  ctx.on('session/event', (session, event) => {
    origin.onEvent(session.id, event)
    const botId = rt.chatOwners.get(session.id)
    if (botId === undefined) return
    const reply = origin.deliveryOf(session.id)
    if (reply === undefined) return
    const cardId = rt.cardOfSession?.(session.id)
    const card = cardId === undefined ? '' : `${rt.botOf(botId)?.name ?? '?'} · ${cardId}`
    const label = card === '' ? '' : `**${card}**: `
    const chat = { key: reply.chatKey, kind: reply.chat.kind, title: reply.chat.title }
    for (const item of rt.displayItems(session.id, [event])) {
      if (item.kind !== 'bot' && item.kind !== 'view') continue
      const body = label + (item.kind === 'bot' ? item.text : viewCardText({ title: item.title, view: item.view }) || (item.title ?? ''))
      enqueue(reply.conn, reply.chatKey, { chat, text: body, canSend: (reply as any).canSend })
    }
    if (event.type === 'deliverables/presented') {
      for (const file of Array.isArray(event.data?.files) ? event.data.files : []) {
        if (typeof file?.path !== 'string') continue
        enqueue(reply.conn, reply.chatKey, { chat, canSend: (reply as any).canSend, file: { path: file.path, label, ...(card === '' ? {} : { caption: card }) } })
      }
    }
  })

  rt.onRoomLine((room, line) => {
    if (line.botId === undefined || line.kind !== undefined || typeof line.text !== 'string' || line.text.trim() === '') return
    const reply = origin.deliveryOf(room.sessionId ?? room.id)
    if (reply === undefined) return
    const body = `**${line.who}**: ${line.text}`
    const chat = { key: reply.chatKey, kind: reply.chat.kind, title: reply.chat.title }
    enqueue(reply.conn, reply.chatKey, { chat, text: body, canSend: (reply as any).canSend })
  })

  rt.onApproval((kind, data) => {
    if (kind === 'open') {
      void (async () => {
        const sessionId = data.roomId !== undefined ? (rt.roomOf(data.roomId)?.sessionId ?? data.roomId) : chatOfBot(data.botId)
        const reply = origin.deliveryOf(sessionId)
        if (reply === undefined) return
        const bot = rt.botOf(data.botId)
        const buttons = imPlatform(reply.conn.platform)?.buttons === true ? cardButtons.approval(data.id) : undefined
        await sendCard(reply.conn, `a:${data.id}`, [reply], cardText.approval(bot?.name ?? '?', data), buttons)
      })().catch(error => rt.warn('ds-bot: im approval card failed: %s', error))
      return
    }
    void (async () => {
      for (const conn of Object.values(connections())) {
        await settleCard(conn.id, `a:${data.id}`, data.outcome === 'allowed-once' ? text('allow') : data.outcome === 'rejected' ? text('reject') : text('answered'))
        await settledEdits(conn)
      }
    })().catch(() => {})
  })

  rt.onSaved(() => {
    void diffCards().then(settleGone).catch(() => {})
    void sync().catch(() => {})
  })

  const syncOrigins = () => {
    origin.prune()
    return sync()
  }
  let interval
  ctx.effect(() => {
    interval = setInterval(() => {
      void rt.refresh().then(syncOrigins).catch(() => {})
    }, RECONCILE_MS)
    interval.unref?.()
    void rt.load().then(syncOrigins).catch(() => {})
    return () => {
      stopped = true
      clearInterval(interval)
      stopWatchingSessions?.()
      origin.clear()
      return Promise.all([...runners.keys()].map(stop)).then(async () => {
        for (const held of runtimes.values()) if (held.timer !== undefined) clearTimeout(held.timer)
        await Promise.all([...runtimes.keys()].map(writeRuntime)).catch(() => {})
      })
    }
  }, 'ds-bot: im')

  const imView = () => ({ connections: Object.values(connections()).map(viewOf), platforms: IM_PLATFORMS.filter(platform => adaptersFor().includes(platform.id)).map(platform => platform.id) })
  const imStatusView = () => Object.fromEntries([...new Set([...statuses.keys(), ...outbox.statusIds()])].map((id) => {
    const status = outbox.statusOf(id, statuses.get(id))
    return [id, { state: status.state, ...(status.error !== undefined ? { error: status.error } : {}), at: status.at }]
  }))

  Object.assign(rt, { imView, imStatusView, imViaView: origin.viaView, imEndpoint, imPush, replyOrigin: origin })
}
