export function every(ms, job, { readOnly = () => false, onError = error => console.warn(error) }: any = {}) {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      if (!readOnly()) await job()
    } catch (error) {
      onError(error)
    } finally {
      running = false
    }
  }, ms)
  timer.unref()
  return () => clearInterval(timer)
}
