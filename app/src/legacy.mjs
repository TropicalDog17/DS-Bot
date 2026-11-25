import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const PRODUCT_NAME = 'DS Bot'
export const APP_ID = 'io.github.fei2411.dsbot'
export const LEGACY_PRODUCT_NAME = 'DeepSeek Bot'
export const LEGACY_ENGINE = 'deepseek-bot-engine'
export const LEGACY_ARTIFACT_PREFIX = 'DeepSeek-Bot'

export function configureIdentity(app, { env = process.env, platform = process.platform, exists = existsSync, mkdir = mkdirSync } = {}) {
  const current = app.getPath('userData')
  const explicit = env.DS_BOT_SHELL_DATA
  const legacy = explicit || env.DS_BOT_HOME ? undefined : join(app.getPath('appData'), LEGACY_PRODUCT_NAME)
  const reuse = legacy !== undefined && exists(legacy) && !exists(join(current, 'locations.json'))
  const userData = explicit || (reuse ? legacy : current)
  mkdir(userData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  if (platform === 'win32') app.setAppUserModelId(APP_ID)
  if (reuse && platform !== 'win32') {
    app.setName(LEGACY_PRODUCT_NAME)
    app.once('ready', () => { app.setName(PRODUCT_NAME) })
  }
  return { userData, legacy: reuse }
}
