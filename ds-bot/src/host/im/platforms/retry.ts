export const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 15_000, 30_000]

export const retryDelay = attempt => RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), RETRY_DELAYS_MS.length - 1)]

export const retryWait = ms => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})
