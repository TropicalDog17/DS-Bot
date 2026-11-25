export function createDeferredPrompt({ ask, shown, onYes, log = console }) {
  let waiting
  const prompt = async (version) => {
    if (!shown()) {
      waiting = version
      log.info(`DS Bot: the update ${version} waits for the window`)
      return false
    }
    return ask(version)
  }
  const flush = async () => {
    if (waiting === undefined || !shown()) return
    const version = waiting
    waiting = undefined
    try {
      if (await ask(version)) await onYes?.(version)
    } catch (error) {
      log.error(`DS Bot: the update ${version} could not be asked: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { prompt, flush, waiting: () => waiting }
}
