export async function unreadableSessions(persistence, ids) {
  const unreadable = []
  for (const id of ids) {
    try {
      const handle = await persistence.open(id, 'read')
      try {
        await handle.read()
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error?.name === 'SessionFormatUnsupportedError') unreadable.push(id)
      else console.warn(`DS Bot: could not read ${id} while checking the team: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return unreadable
}
