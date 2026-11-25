// ds-bot-board: the user's kanban board as its own DSH plugin, beside DS Bot. Off
// until the profile mounts it (see docs/plans/2026-11-19-board-plugin.md):
//
//   - insert:
//       - id: board
//         name: ds-bot/board
//
// Config (all optional): { file: '/abs/board.json' }; default <DSH_HOME>/bot-board/board.json.
import { install } from './plugin.ts'
import { herdrSkillProvider } from './skill.ts'

export const name = 'ds-bot-board'
export const inject = ['botSessionIdentity', 'dsBotRoster', 'dsBotNotes', 'dsBotBridge', 'tools', 'connection', 'systemPrompt']

export function apply(ctx, config = {}) {
  ctx.inject?.({ skills: null }, sub => sub.skills.registerProvider(() => herdrSkillProvider()))
  ctx.effect(() => {
    const handle = install(ctx, config, {
      identity: ctx.botSessionIdentity, roster: ctx.dsBotRoster, notes: ctx.dsBotNotes, bridge: ctx.dsBotBridge,
      tools: ctx.tools, connection: ctx.connection, systemPrompt: ctx.systemPrompt,
    })
    return () => handle.dispose()
  }, 'ds-bot-board')
}
