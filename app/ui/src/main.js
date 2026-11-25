import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { ABOUT_CSS } from '../../../ds-bot/src/client/about.ts'
import { BOT_SETTINGS_CSS } from '../../../ds-bot/src/client/bot-settings.ts'
import { FEEDBACK_CSS } from '../../../ds-bot/src/client/feedback.ts'
import { FOLDER_CSS } from '../../../ds-bot/src/client/folder-menu.ts'
import { GROUP_SETTINGS_CSS } from '../../../ds-bot/src/client/group-settings.ts'
import { MEMBER_CSS } from '../../../ds-bot/src/client/member-status.ts'
import { MODEL_CSS } from '../../../ds-bot/src/client/model-menu.ts'
import { PROVIDERS_CSS } from '../../../ds-bot/src/client/providers-page.ts'
import { READ_ONLY_CSS } from '../../../ds-bot/src/client/read-only-dock.ts'
import { SCHEDULE_CSS } from '../../../ds-bot/src/client/schedules.ts'
import { SECRET_CSS } from '../../../ds-bot/src/client/secret-card.ts'
import { SIDEBAR_CSS } from '../../../ds-bot/src/client/sidebar.ts'
import { CONVERSATION_CSS, SHELL_CSS, installStyles } from '../../../ds-bot/src/client/styles.ts'
import { USAGE_CSS } from '../../../ds-bot/src/client/usage-page.ts'
import { App } from './app.js'
import './app.css'

document.documentElement.lang = 'en'
// macOS puts the window buttons at the band's left end, over the sidebar (app.css).
if (/mac/iu.test(navigator.userAgentData?.platform ?? navigator.platform)) document.documentElement.dataset.mac = ''

// The Bot views' own stylesheets, the same ones the plugin puts in DSH.
for (const [tag, text] of [
  ['shell', SHELL_CSS], ['sidebar', SIDEBAR_CSS], ['conversation', CONVERSATION_CSS + READ_ONLY_CSS], ['secrets', SECRET_CSS], ['providers', PROVIDERS_CSS],
  ['models', MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + GROUP_SETTINGS_CSS], ['usage', USAGE_CSS], ['schedules', SCHEDULE_CSS],
  ['feedback', FEEDBACK_CSS], ['about', ABOUT_CSS], ['members', MEMBER_CSS],
]) installStyles(text, tag)

// The plugin's colors switch on body[data-ds-dark-theme], which DSH sets; here the system's
// light or dark mode sets it.
const dark = matchMedia('(prefers-color-scheme: dark)')
const paint = () => { document.body.toggleAttribute('data-ds-dark-theme', dark.matches) }
paint()
dark.addEventListener('change', paint)

createRoot(document.getElementById('root')).render(h(App))
