export const POLL_MAX_MS = 5_000

export function pollDelay(base, unchanged) {
  const steps = Math.min(Math.max(unchanged, 0), 8)
  return Math.min(base * 2 ** steps, Math.max(base, POLL_MAX_MS))
}

export function needsIdleSample(computer, settings) {
  return (Object.values(computer?.bots ?? {}) as any[]).some(entry => entry?.waitingFor === 'user-idle')
    || (Object.values(settings?.bots ?? {}) as any[]).some(bot => bot?.level === 'foreground')
}
