// ds-bot-board: the user's kanban board as its own DSH plugin, beside DS Bot. Off
// until the profile mounts it (see docs/plans/2026-11-19-board-plugin.md):
//
//   - insert:
//       - id: board
//         name: ds-bot/board
//
// Config (all optional): { file: '/abs/board.json' }; default <DSH_HOME>/bot-board/board.json.
import { install } from './plugin.js'

export const name = 'ds-bot-board'
export const inject = ['botSessionIdentity', 'dsBotRoster', 'dsBotNotes', 'dsBotBridge', 'tools', 'connection']

export function apply(ctx, config = {}) {
  ctx.effect(() => {
    const handle = install(ctx, config, {
      identity: ctx.botSessionIdentity, roster: ctx.dsBotRoster, notes: ctx.dsBotNotes, bridge: ctx.dsBotBridge,
      tools: ctx.tools, connection: ctx.connection,
    })
    return () => handle.dispose()
  }, 'ds-bot-board')
}
