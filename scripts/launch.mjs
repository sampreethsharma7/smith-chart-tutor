// The second half of the one-click start (Start-Windows.cmd, Start-Mac.command, Start-Linux.sh).
// Those scripts only fetch a private Node.js into .runtime/; this does the rest, the same on
// every OS: install the app's components when they're missing or changed, build the app when
// its source is newer than the last build, then start it and get out of the way.
// Nothing is installed system-wide and no admin rights are needed.
//
//   node scripts/launch.mjs [--no-launch]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const runtime = join(root, '.runtime')
mkdirSync(runtime, { recursive: true })

function fail(what, hints = []) {
  console.error(`\n  ✗ ${what}`)
  for (const h of hints) console.error(`    • ${h}`)
  console.error('')
  process.exit(1)
}

const NETWORK_HINTS = [
  'Check the internet connection, then double-click the start file again: it carries on where it stopped.',
  'On a company network, a proxy may block downloads. If your IT uses one, set HTTPS_PROXY (e.g. http://proxy.company.com:8080) and try again.',
  'The first run downloads about 150 MB from registry.npmjs.org and github.com.'
]

// The environment for npm and the app: our Node first on PATH, npm's cache inside .runtime, no nagging.
const env = { ...process.env }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`
Object.assign(env, {
  npm_config_cache: join(runtime, 'npm-cache'),
  electron_config_cache: join(runtime, 'electron-cache'), // Electron's own download, kept in this folder too
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_update_notifier: 'false',
  npm_config_loglevel: 'error'
})
// Electron's own download goes through the proxy too, when there is one.
if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) env.ELECTRON_GET_USE_PROXY = '1'
delete env.ELECTRON_RUN_AS_NODE

const npmCli = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows layout
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js') // macOS / Linux layout
].find(existsSync)
if (!npmCli) fail('npm was not found next to Node.js.', ['Delete the .runtime folder in this folder and double-click the start file again.'])

function npm(args, hints) {
  const r = spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit', env })
  if (r.status !== 0) fail(`"npm ${args.join(' ')}" did not finish.`, hints)
}

// ── 1. The app's components: installed once, again only when package-lock.json changes ──
const require = createRequire(join(root, 'package.json'))
function electronBinary() {
  try {
    const p = require('electron') // the path to Electron's executable, if it's fully installed
    return typeof p === 'string' && existsSync(p) ? p : null
  } catch {
    return null
  }
}
const lockFile = join(root, 'package-lock.json')
const installedStamp = join(runtime, 'installed-lock.json')
const lock = readFileSync(lockFile, 'utf8')
let installed = false
if (!electronBinary() || !existsSync(installedStamp) || readFileSync(installedStamp, 'utf8') !== lock) {
  console.log('\n  [2/3] Installing the app\'s components into this folder (first run only, a few minutes)…\n')
  npm(['ci', '--no-audit', '--no-fund'], NETWORK_HINTS)
  if (!electronBinary()) fail('Electron did not install completely.', NETWORK_HINTS)
  writeFileSync(installedStamp, lock)
  installed = true
}

// ── 2. The build: again only when something it's made from is newer than the last build ──
const buildStamp = join(root, 'out', '.build-stamp')
function newest(p) {
  if (!existsSync(p)) return 0
  const s = statSync(p)
  if (!s.isDirectory()) return s.mtimeMs
  return Math.max(0, ...readdirSync(p).map((f) => newest(join(p, f))))
}
const sources = ['src', 'package.json', 'electron.vite.config.ts', 'tsconfig.json'].map((f) => join(root, f))
if (installed || !existsSync(buildStamp) || Math.max(...sources.map(newest)) > statSync(buildStamp).mtimeMs) {
  console.log('\n  [3/3] Building the app…\n')
  npm(['run', 'build', '--', '--logLevel', 'warn'], ['Delete the "out" folder in this folder and try again.'])
  writeFileSync(buildStamp, new Date().toISOString())
}

// ── 3. Start it, detached, so this window can close ──
if (process.argv.includes('--no-launch')) {
  console.log('\n  ✓ Ready (not started: --no-launch).\n')
  process.exit(0)
}
delete env.NODE_OPTIONS // set by the start scripts for npm's downloads; not meant for the app
const app = spawn(electronBinary(), ['.'], { cwd: root, env, detached: true, stdio: 'ignore' })
app.on('error', (e) => fail(`The app could not start: ${e.message}`))
app.unref()
console.log('\n  ✓ Smith Chart Tutor is starting. You can close this window.\n')
setTimeout(() => process.exit(0), 500)
