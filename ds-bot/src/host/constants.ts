export const COLORS = ['deepseek', 'blue', 'violet', 'orange', 'green', 'magenta', 'cyan', 'red', 'yellow', 'brown', 'gray', 'black', 'aurora']
export const EXTRA_COLORS = ['charcoal', 'graphite', 'rose', 'sky', 'tangerine', 'cobalt']
export const LEGACY_COLORS = { kimi: 'charcoal', zai: 'graphite', minimax: 'rose', stepfun: 'sky', mimo: 'tangerine', qwen: 'cobalt' }
export const LEGACY_THEMES = { grok: 'mono' }

export const OCR_PROMPT = [
  'Transcribe all text in this image exactly, in its original language, keeping line breaks and reading order; use Markdown tables for tables.',
  'Then add a line starting with "Image:" that describes in one to three sentences what is not text (photo, chart, diagram, screen layout).',
  'Reply with only that. If there is no text, reply with only the "Image:" line.',
].join(' ')
export const OCR_TIMEOUT_MS = 120_000
export const OCR_RETRY_MS = 120_000
export const OCR_CACHE_MAX = 500
export const MAX_AVATAR_IMAGE = 160_000
export const ROUTE = '/api/bot'
export const MAX_EXCHANGES = 600
export const TEXT_KEPT = 2000
export const GROUP_LINE_READ = 20_000
export const TEXT_SHOW_MAX = 200_000
export const MESSAGE_INLINE_MAX = GROUP_LINE_READ
export const LONG_HEAD = 1000
// DSH's read tool shows this much of one line (dsh-tool-fs `readMaxLineLength`, default).
export const READ_LINE_MAX = 2000
export const ROOM_REPLY_TIMEOUT_MS = 240_000
export const ROOM_STEP_GAP_MS = 30_000
export const SOURCE_KIND = 'bot'
export const HANDOFF_ACK = 'Noted. I have my handoff note and carry on from here.'
export const LATE_ANSWER = '[Late answer: the user had already given up waiting for this work; its result was settled then.]\n\n'
// An answer from a question card, in the shape DSH's own late question replies use.
export const REPLY_KIND = 'user-question-reply'
// DSH's snapshot of a referenced conversation, logged right after the user's message
// that cites it.
export const REFERENCE_KIND = 'session-reference'
export const ROOM_MODES = ['everyone', 'admin']
export const ROOM_NAME_MAX = 60
export const ROOM_NOTICE_MAX = 2000
export const ROOM_MAX_MEMBERS = 12
export const SECTION_NAME_MAX = 32
export const SECTION_COLORS = ['blue', 'orange', 'green', 'violet', 'rose']

export const AGENT_NAME = 'DSH Agent'
export const AGENT_SESSION_TITLE_MAX = 80
export const TEAM_TOOLS = [
  'list_bots', 'message_bot', 'stop_bot', 'create_bot', 'update_bot', 'list_bot_models',
  'create_group', 'update_group', 'delete_group', 'post_to_group', 'ask_user', 'show_view',
  'request_secret', 'list_secrets', 'group_relay', 'read_own_chat',
  'read_group_chat', 'remember', 'forget', 'recall', 'read_browser',
  'list_capabilities', 'save_capability', 'delete_capability',
  'attach_capability', 'detach_capability', 'list_connectors', 'request_connector',
]
export const ROOM_WORK_GRACE_MS = 15_000
export const ROOM_IDLE_RELAY_LIMIT = 6
export const APPROVAL_REMIND_MS = 5 * 60_000

export const OWN_CHAT_LINE_MAX = 400
export const ANCHOR_LINE_MAX = 8000
export const OWN_CHAT_BRIEF = 10
export const OWN_CHAT_READ = 12
export const OWN_CHAT_SEARCH = 20
export const HISTORY_PAGE = 200
export const HISTORY_PAGES_MAX = 50
export const HISTORY_TIMEOUT_MS = 20_000
export const ASIDE_LIMIT = 'Answer cut off at the output limit.'

export const STEER_CUT = 'ds-bot/steer'
