import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { stringify } from 'yaml'

export const APP_PATCH_NAME = 'app-onboarding.patch.yml'
export const APP_PATCH_ROWS = [
  { id: 'ui-settings-models', name: '@deepseek-ai/dsh-client-ui-settings-models', config: { credentialOnboarding: false } },
]

export function writeAppPatch(profile) {
  const file = join(dirname(profile.dir), APP_PATCH_NAME)
  writeFileSync(file, stringify(APP_PATCH_ROWS), 'utf8')
  return [file]
}
