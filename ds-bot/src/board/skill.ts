// The herdr-panes skill: how a Bot drives herdr panes from outside herdr. herdr's own
// skill stops unless the agent runs inside a herdr pane, which a Bot never does.
import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER = 'ds-bot-board'
const NAME = 'herdr-panes'
const DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'skills', NAME)
const LOCATOR = join(DIRECTORY, 'SKILL.md')

function parse(raw) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const description = /^description:\s*(.+)$/mu.exec(frontmatter?.[1] ?? '')?.[1]?.trim()
  if (!description) throw new Error(`${PROVIDER}: ${LOCATOR} has no description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

export function herdrSkillProvider() {
  const candidate = {
    name: NAME,
    description: parse(readFileSync(LOCATOR, 'utf8')).description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER, source: 'bundled', rank: 600,
    resourceBase: { kind: 'directory', path: DIRECTORY.split(sep).join('/') },
    locator: LOCATOR,
  }
  return {
    name: PROVIDER,
    list: () => Promise.resolve([candidate]),
    get: () => Promise.resolve({ ...candidate, ...parse(readFileSync(LOCATOR, 'utf8')) }),
  }
}
