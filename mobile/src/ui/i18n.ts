// Phone copy is English, as on the desktop: the English text is the key, so `t`
// only fills `{name}` slots.
const fill = (text: string, params?: Record<string, string | number>) =>
  params === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])))

export function t(key: string, params?: Record<string, string | number>): string {
  return fill(key, params)
}

// Built by hand: Hermes formats dates in the system locale whatever locale is
// asked for, and the interface is English.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const pad = (n: number) => String(n).padStart(2, '0')
export const dayLabel = (time: number) => {
  const d = new Date(time)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}
export const timeLabel = (time: number) => `${dayLabel(time)} ${pad(new Date(time).getHours())}:${pad(new Date(time).getMinutes())}`

// The desktop's message stamps (text.js clockLabel / messageClock), built by hand
// for the same Hermes reason as dayLabel.
const clock = (time: number) => `${new Date(time).getHours()}:${pad(new Date(time).getMinutes())}`
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const daysBefore = (time: number, now: number) => Math.round((midnight(new Date(now)) - midnight(new Date(time))) / 86400000)
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ISO_WEEK_EN = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export const weekdayShort = (day: number) => ISO_WEEK_EN[day] ?? String(day)
export function clockLabel(time: number, now = Date.now()): string {
  const days = daysBefore(time, now)
  if (days === 0) return t('Today {time}', { time: clock(time) })
  if (days === 1) return t('Yesterday {time}', { time: clock(time) })
  const d = new Date(time)
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `, ${d.getFullYear()}`
  return `${WEEK_EN[d.getDay()]}, ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}${year} ${clock(time)}`
}
export const messageClock = (time: number, now = Date.now()) => (daysBefore(time, now) === 0 ? clock(time) : clockLabel(time, now))
