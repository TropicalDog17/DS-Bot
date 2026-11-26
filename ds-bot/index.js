import { join } from 'node:path'
import * as diagnostics from './src/host/diagnostics.ts'
import * as store from './src/host/store.ts'
import * as sessionIdentity from './src/host/session-identity.ts'
import * as companions from './src/host/companions.ts'
import * as models from './src/host/models.ts'
import * as providers from './src/host/providers.ts'
import * as permissions from './src/host/permissions.ts'
import * as settlement from './src/host/settlement.ts'
import * as turns from './src/host/turns.ts'
import * as steer from './src/host/steer.ts'
import * as handoffs from './src/host/handoffs.ts'
import * as dispatch from './src/host/dispatch.ts'
import * as roster from './src/host/roster.ts'
import * as folders from './src/host/folders.ts'
import * as privacy from './src/host/privacy.ts'
import * as agents from './src/host/agents.ts'
import * as prompt from './src/host/prompt.ts'
import * as routing from './src/host/routing.ts'
import * as timeContext from './src/host/time-context.ts'
import * as tools from './src/host/tools.ts'
import * as chatIndex from './src/host/chat-index.ts'
import * as groups from './src/host/groups.ts'
import * as ledger from './src/host/ledger.ts'
import * as agentCommands from './src/host/agent-commands.ts'
import * as approvals from './src/host/approvals.ts'
import * as resume from './src/host/resume.ts'
import * as memory from './src/host/memory.ts'
import * as parts from './src/host/parts.ts'
import * as changes from './src/host/changes.ts'
import * as images from './src/host/images.ts'
import * as avatarLibrary from './src/host/avatar-library.ts'
import * as browser from './src/host/browser.ts'
import * as browserPlugins from './src/host/browser-plugins.ts'
import * as computer from './src/host/computer/index.ts'
import * as secrets from './src/host/secrets.ts'
import * as connectors from './src/host/connectors/index.ts'
import * as capabilities from './src/host/capabilities.ts'
import * as learning from './src/host/learning.ts'
import * as schedules from './src/host/schedules.ts'
import * as usage from './src/host/usage.ts'
import * as update from './src/host/update.ts'
import * as dshUpdate from './src/host/dsh-update.ts'
import * as thinking from './src/host/thinking.ts'
import * as phone from './src/host/phone.ts'
import * as channel from './src/host/channel.ts'
import * as remote from './src/host/remote.ts'
import * as mobile from './src/host/mobile.ts'
import * as feed from './src/host/feed.ts'
import * as im from './src/host/im/index.ts'
import * as officeSkills from './src/host/office-skills.ts'
import * as localAgents from './src/host/local-agents/index.ts'

export { COLORS } from './src/host/constants.ts'

export { name, inject } from './src/host/entry.ts'

const MODULES = [diagnostics, store, sessionIdentity, companions, ledger, models, providers, permissions, settlement, turns, steer, handoffs, dispatch, roster, folders, privacy, agents, prompt, routing, timeContext, tools, chatIndex, groups, agentCommands, approvals, resume, memory, parts, changes, images, avatarLibrary, secrets, connectors, capabilities, learning, schedules, browser, browserPlugins, computer, usage, update, dshUpdate, thinking, mobile, feed, phone, im, channel, remote, officeSkills, localAgents]

export function apply(ctx, config = {}) {
  createRuntime(ctx, config)
}

export function createRuntime(ctx, config = {}) {
  const dshHome = folders.dshHomeOf(process.env.DSH_HOME)
  const home = config.home ?? join(dshHome, 'bot')
  const rt = {
    ctx,
    config,
    dshHome,
    home,
    statePath: join(home, 'state.json'),
    teamTools: [],
    defaults: {
      mainName: config.mainName ?? 'Chief',
      mainRole: config.mainRole ?? 'Chief of Staff',
    },
  }
  for (const module of MODULES) module.install(rt)
  rt.syncScopedTools?.()
  // dsh can load this plugin again in place, its files replaced while it runs: dsh
  // keeps the turns and child agents it had, while this runtime starts with empty
  // maps. Adopt them now, so Stop, the group view and a late child settle still see
  // the work. A fresh start has nothing to adopt.
  void rt.adoptLiveWork?.().catch(error => rt.warn?.('ds-bot: adopting the work still running failed: %s', error))
  return rt
}
