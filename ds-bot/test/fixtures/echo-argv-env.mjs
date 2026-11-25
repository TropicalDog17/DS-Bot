const names = (process.env.ECHO_ARGV_ENV_NAMES ?? '').split(',').filter(Boolean)
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  env: Object.fromEntries(names.map(name => [name, process.env[name] ?? null])),
}))
