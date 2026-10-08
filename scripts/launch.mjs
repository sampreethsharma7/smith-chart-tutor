// The second half of the one-click start (Start-Windows.cmd, Start-Mac.command, Start-Linux.sh).
// Those scripts only fetch a private Node.js into .runtime/; this does the rest, the same on
// every OS: install the app's components when they're missing or changed, build the app when
// its source differs from the last build, then start it and get out of the way.
// Nothing is installed system-wide and no admin rights are needed.
//
//   node scripts/launch.mjs [--no-launch]
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  'The first run downloads about 150 MB from registry.npmjs.org and github.com, and needs about 600 MB of free disk space.',
  'Antivirus software sometimes locks files while it scans them: waiting a minute and trying again usually helps.'
]

// One setup at a time: a second double-click while the first is still installing would corrupt it.
const lockPath = join(runtime, 'setup.lock')
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
if (existsSync(lockPath)) {
  const pid = Number(readFileSync(lockPath, 'utf8'))
  if (pid && pid !== process.pid && alive(pid)) {
    console.log("\n  Setup is already running in another window. The app opens from there when it's ready.\n")
    process.exit(0)
  }
}
writeFileSync(lockPath, String(process.pid))
process.on('exit', () => {
  try {
    if (readFileSync(lockPath, 'utf8') === String(process.pid)) rmSync(lockPath)
  } catch {}
})

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
// The path to Electron's executable, downloading it if it's missing: Electron fetches its program the
// first time it's asked for, not during npm install. Asked in a fresh Node each time, with the same
// proxy and cache settings as npm: require() here would remember an answer from before a reinstall.
const electronPathFile = join(runtime, 'electron-path.txt')
const FIND_ELECTRON = `let p = ''
try { p = require('electron') } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') console.error(e.message) }
require('fs').writeFileSync(process.argv[1], typeof p === 'string' ? p : '')`
function electronBinary() {
  rmSync(electronPathFile, { force: true })
  spawnSync(process.execPath, ['-e', FIND_ELECTRON, electronPathFile], { stdio: 'inherit', env, cwd: root })
  const p = existsSync(electronPathFile) ? readFileSync(electronPathFile, 'utf8').trim() : ''
  return p && existsSync(p) ? p : null
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

// ── 2. The build: again only when what it's made from has changed ──
// By content, not file dates: a new ZIP extracted over this folder keeps the ZIP's (older) dates.
const buildStamp = join(root, 'out', '.build-stamp')
function hashTree(h, p) {
  if (!existsSync(p)) return
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p).sort()) hashTree(h, join(p, f))
  } else {
    h.update(p.slice(root.length)).update(readFileSync(p))
  }
}
const sourceHash = (() => {
  const h = createHash('sha256')
  for (const f of ['src', 'package.json', 'package-lock.json', 'electron.vite.config.ts', 'tsconfig.json']) hashTree(h, join(root, f))
  return h.digest('hex')
})()
const built = existsSync(buildStamp) ? readFileSync(buildStamp, 'utf8').trim() : ''
if (installed || built !== sourceHash || !existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.log('\n  [3/3] Building the app…\n')
  // The build tool runs directly with Node, not through "npm run": npm runs scripts through
  // Windows' cmd, which breaks on folder names with "&" (e.g. "R&D").
  const r = spawnSync(process.execPath, [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build', '--logLevel', 'warn'], { stdio: 'inherit', env, cwd: root })
  if (r.status !== 0) fail('The app could not be built.', ['Delete the "out" folder in this folder and try again.', 'If it keeps failing, extract the ZIP again into a new folder.'])
  writeFileSync(buildStamp, sourceHash)
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
