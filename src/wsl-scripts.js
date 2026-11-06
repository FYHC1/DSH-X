/*
MIT License

Copyright (c) 2026 Nexus contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

/**
 * WSL 里跑的那半截启动器。
 *
 * 为什么要有这个脚本：WSL 实例不是 Windows 上的一个普通子进程。wsl.exe 只是
 * 一扇门，门后面还有 bash、dsh、以及 WSL 自己的进程树；从 Windows 直接 taskkill
 * 只能杀掉门，门后面的 dsh 可能继续占着端口。启动、停止、状态都放在同一个脚本里，
 * 让「谁写的 pidfile 谁负责收尸」这件事只有一个实现。
 *
 * 两种服务模式共用同一套 pidfile 约定：
 * - wrapper：脚本前台 exec dsh，wsl.exe 的 stdout 就是 dsh 的 stdout；
 * - systemd：脚本写一个 systemd user unit，unit 里再 exec dsh，Windows 侧 tail journal。
 *
 * 首版的生命周期只靠 pidfile / 端口探针，不额外起 WSL 内的常驻桥进程；桥属于插件代理那一版。
 */

const wrapperLines = [
  "#!/usr/bin/env bash",
  "set -u",
  "",
  "action=\"${1:-}\"",
  "if [ -n \"$action\" ]; then shift; fi",
  "",
  "# 状态目录固定放在 Linux 用户自己的 HOME 下，不跟 DSH_HOME 走：",
  "# 同一个 HOME 下可能有好几个 DSH_HOME，每个实例的 pidfile 不能混。",
  "state_dir=\"${DSH_X_WSL_STATE_DIR:-$HOME/.dsh-x}\"",
  "run_dir=\"$state_dir/run\"",
  "mkdir -p \"$run_dir\" \"$state_dir/logs\"",
  "",
  "expand_home() {",
  "  case \"$1\" in",
  "    \"~\") printf '%s' \"$HOME\" ;;",
  "    \"~/\"*) printf '%s/%s' \"$HOME\" \"${1:2}\" ;;",
  "    *) printf '%s' \"$1\" ;;",
  "  esac",
  "}",
  "",
  "# TERM 后最多等 5 秒，仍不退才 KILL；停止路径要可预期，不能无限等。",
  "stop_pid() {",
  "  p=\"$1\"",
  "  kill -TERM \"$p\" 2>/dev/null || true",
  "  i=0",
  "  while [ \"$i\" -lt 50 ]; do",
  "    kill -0 \"$p\" 2>/dev/null || return 0",
  "    sleep 0.1",
  "    i=$((i + 1))",
  "  done",
  "  kill -KILL \"$p\" 2>/dev/null || true",
  "}",
  "",
  "case \"$action\" in",
  "  start)",
  "    id=\"${1:?missing instance id}\"",
  "    profile=\"${2:?missing profile}\"",
  "    dsh_home=\"${3:-}\"",
  "    workdir=\"${4:-}\"",
  "    port=\"${5:?missing port}\"",
  "    dsh_cmd=\"${6:-dsh}\"",
  "    shift 6 || true",
  "    if [ -z \"$dsh_home\" ]; then dsh_home=\"$HOME/.dsh\"; fi",
  "    dsh_home=\"$(expand_home \"$dsh_home\")\"",
  "    export DSH_HOME=\"$dsh_home\"",
  "    if [ -n \"$workdir\" ]; then",
  "      workdir=\"$(expand_home \"$workdir\")\"",
  "      cd \"$workdir\" || { echo \"dsh-x: workdir 不存在：$workdir\" >&2; exit 66; }",
  "    else",
  "      cd \"$dsh_home\" 2>/dev/null || cd \"$HOME\" || exit 66",
  "    fi",
  "    pidfile=\"$run_dir/$id.pid\"",
  "    if [ -f \"$pidfile\" ]; then",
  "      old_pid=\"$(cat \"$pidfile\" 2>/dev/null || true)\"",
  "      if [ -n \"$old_pid\" ] && kill -0 \"$old_pid\" 2>/dev/null; then",
  "        echo \"dsh-x: 这个 WSL 实例已经在运行（PID $old_pid）\" >&2",
  "        exit 0",
  "      fi",
  "      rm -f \"$pidfile\"",
  "    fi",
  "    echo $$ > \"$pidfile\"",
  "    echo \"dsh-x: 启动 $dsh_cmd $profile --host 127.0.0.1 --port $port\"",
  "    # exec 很关键：pidfile 里的 PID 必须就是 dsh 本体的 PID，停止时才能精确杀。",
  "    exec \"$dsh_cmd\" \"$profile\" --host 127.0.0.1 --port \"$port\" --no-open \"$@\"",
  "    ;;",
  "  stop)",
  "    id=\"${1:?missing instance id}\"",
  "    port=\"${2:-}\"",
  "    pidfile=\"$run_dir/$id.pid\"",
  "    pid=\"\"",
  "    if [ -f \"$pidfile\" ]; then pid=\"$(cat \"$pidfile\" 2>/dev/null || true)\"; fi",
  "    if [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then",
  "      stop_pid \"$pid\"",
  "    fi",
  "    rm -f \"$pidfile\"",
  "    # pidfile 丢了（例如 Windows 侧被杀）时，按端口兜底收一次；但端口可能已被别的",
  "    # 服务复用，必须先看命令行确实是 dsh 且带这个端口，避免误杀无关进程。",
  "    if [ -z \"$pid\" ] && [ -n \"$port\" ] && command -v fuser >/dev/null 2>&1; then",
  "      port_pids=\"$(fuser -n tcp \"$port\" 2>/dev/null || true)\"",
  "      for p in $port_pids; do",
  "        cmd=\"$(tr '\\0' ' ' < \"/proc/$p/cmdline\" 2>/dev/null || true)\"",
  "        case \"$cmd\" in",
  "          *dsh*\"--port $port\"*|*dsh*\"--port=$port\"*) stop_pid \"$p\" ;;",
  "        esac",
  "      done",
  "    fi",
  "    exit 0",
  "    ;;",
  "  status)",
  "    id=\"${1:?missing instance id}\"",
  "    pidfile=\"$run_dir/$id.pid\"",
  "    if [ -f \"$pidfile\" ]; then",
  "      pid=\"$(cat \"$pidfile\" 2>/dev/null || true)\"",
  "      if [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then",
  "        echo \"running:$pid\"",
  "        exit 0",
  "      fi",
  "    fi",
  "    echo \"stopped\"",
  "    exit 1",
  "    ;;",
  "  *)",
  "    echo \"dsh-x: 未知操作：$action\" >&2",
  "    exit 64",
  "    ;;",
  "esac"
]

export const WSL_AGENT_SCRIPT = wrapperLines.join('\n')

const systemdLines = [
  "#!/usr/bin/env bash",
  "set -u",
  "",
  "action=\"${1:-}\"",
  "if [ -n \"$action\" ]; then shift; fi",
  "state_dir=\"${DSH_X_WSL_STATE_DIR:-$HOME/.dsh-x}\"",
  "run_dir=\"$state_dir/run\"",
  "unit_dir=\"$HOME/.config/systemd/user\"",
  "mkdir -p \"$run_dir\" \"$unit_dir\" \"$state_dir/logs\"",
  "",
  "expand_home() {",
  "  case \"$1\" in",
  "    \"~\") printf '%s' \"$HOME\" ;;",
  "    \"~/\"*) printf '%s/%s' \"$HOME\" \"${1:2}\" ;;",
  "    *) printf '%s' \"$1\" ;;",
  "  esac",
  "}",
  "",
  "# systemd stop 也要有兜底：unit 停了但 pidfile 里的进程还活着时，按 PID 收掉。",
  "stop_pid() {",
  "  p=\"$1\"",
  "  kill -TERM \"$p\" 2>/dev/null || true",
  "  i=0",
  "  while [ \"$i\" -lt 50 ]; do",
  "    kill -0 \"$p\" 2>/dev/null || return 0",
  "    sleep 0.1",
  "    i=$((i + 1))",
  "  done",
  "  kill -KILL \"$p\" 2>/dev/null || true",
  "}",
  "",
  "ensure_systemd() {",
  "  export XDG_RUNTIME_DIR=\"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}\"",
  "  if [ ! -d /run/systemd/system ]; then echo \"dsh-x: 这个发行版没有 systemd\" >&2; exit 69; fi",
  "  if ! command -v systemctl >/dev/null 2>&1; then echo \"dsh-x: 找不到 systemctl\" >&2; exit 69; fi",
  "  systemctl --user show-environment >/dev/null 2>&1 || { echo \"dsh-x: systemd user 会话不可用\" >&2; exit 69; }",
  "}",
  "",
  "case \"$action\" in",
  "  start)",
  "    id=\"${1:?missing instance id}\"",
  "    profile=\"${2:?missing profile}\"",
  "    dsh_home=\"${3:-}\"",
  "    workdir=\"${4:-}\"",
  "    port=\"${5:?missing port}\"",
  "    dsh_cmd=\"${6:-dsh}\"",
  "    if [ -z \"$dsh_home\" ]; then dsh_home=\"$HOME/.dsh\"; fi",
  "    dsh_home=\"$(expand_home \"$dsh_home\")\"",
  "    if [ -n \"$workdir\" ]; then workdir=\"$(expand_home \"$workdir\")\"; fi",
  "    target_dir=\"${workdir:-$dsh_home}\"",
  "    if [ ! -d \"$target_dir\" ]; then target_dir=\"$HOME\"; fi",
  "    pidfile=\"$run_dir/$id.pid\"",
  "    start_script=\"$run_dir/$id-start.sh\"",
  "    {",
  "      echo '#!/usr/bin/env bash'",
  "      echo 'set -u'",
  "      echo \"export DSH_HOME=$(printf '%q' \"$dsh_home\")\"",
  "      echo \"cd $(printf '%q' \"$target_dir\") || exit 66\"",
  "      echo \"echo \\\$\\$ > $(printf '%q' \"$pidfile\")\"",
  "      echo \"exec $(printf '%q' \"$dsh_cmd\") $(printf '%q' \"$profile\") --host 127.0.0.1 --port $(printf '%q' \"$port\") --no-open\"",
  "    } > \"$start_script\"",
  "    chmod 755 \"$start_script\"",
  "    unit=\"$unit_dir/dsh-x-$id.service\"",
  "    cat > \"$unit\" <<EOF",
  "[Unit]",
  "Description=DSH-X WSL dsh web ($profile:$port)",
  "After=network.target",
  "",
  "[Service]",
  "Type=simple",
  "Environment=HOME=%h",
  "ExecStart=/bin/bash \"$start_script\"",
  "Restart=on-failure",
  "RestartSec=3",
  "KillMode=control-group",
  "",
  "[Install]",
  "WantedBy=default.target",
  "EOF",
  "    ensure_systemd",
  "    systemctl --user daemon-reload",
  "    systemctl --user start \"dsh-x-$id.service\"",
  "    sleep 0.2",
  "    if ! systemctl --user is-active --quiet \"dsh-x-$id.service\"; then",
  "      echo \"dsh-x: systemd unit 没起来\" >&2",
  "      systemctl --user status \"dsh-x-$id.service\" --no-pager >&2 || true",
  "      exit 70",
  "    fi",
  "    echo \"started:$id\"",
  "    ;;",
  "  stop)",
  "    id=\"${1:?missing instance id}\"",
  "    unit=\"$unit_dir/dsh-x-$id.service\"",
  "    export XDG_RUNTIME_DIR=\"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}\"",
  "    if [ -f \"$unit\" ]; then",
  "      # --no-block 防止 systemd 卡住时 Windows 侧 30 秒超时先返回、unit 却还在跑；",
  "      # 再轮询 5 秒，必要时用 cgroup 级 SIGKILL 兜底。",
  "      systemctl --user stop --no-block \"dsh-x-$id.service\" 2>/dev/null || true",
  "      i=0",
  "      while [ \"$i\" -lt 50 ]; do",
  "        systemctl --user is-active --quiet \"dsh-x-$id.service\" 2>/dev/null || break",
  "        sleep 0.1",
  "        i=$((i + 1))",
  "      done",
  "      if systemctl --user is-active --quiet \"dsh-x-$id.service\" 2>/dev/null; then",
  "        systemctl --user kill --signal=SIGKILL \"dsh-x-$id.service\" 2>/dev/null || true",
  "      fi",
  "      systemctl --user reset-failed \"dsh-x-$id.service\" 2>/dev/null || true",
  "      rm -f \"$unit\"",
  "      systemctl --user daemon-reload 2>/dev/null || true",
  "    fi",
  "    pid=\"$(cat \"$run_dir/$id.pid\" 2>/dev/null || true)\"",
  "    if [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then stop_pid \"$pid\"; fi",
  "    rm -f \"$run_dir/$id-start.sh\" \"$run_dir/$id.pid\"",
  "    echo stopped",
  "    ;;",
  "  status)",
  "    id=\"${1:?missing instance id}\"",
  "    export XDG_RUNTIME_DIR=\"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}\"",
  "    if systemctl --user is-active --quiet \"dsh-x-$id.service\" 2>/dev/null; then echo \"running:systemd\"; exit 0; fi",
  "    echo stopped",
  "    exit 1",
  "    ;;",
  "  *)",
  "    echo \"dsh-x: 未知操作：$action\" >&2",
  "    exit 64",
  "    ;;",
  "esac"
]

export const WSL_SYSTEMD_SCRIPT = systemdLines.join('\n')

/** Runtime Bridge：只在 WSL 内 127.0.0.1 上监听，token 由 Windows 侧生成。 */
export const WSL_BRIDGE_SCRIPT = `#!/usr/bin/env node
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
function arg(name, fallback = '') {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}
const port = Number(arg('--port'))
const token = arg('--token')
const profile = arg('--profile')
const webPort = Number(arg('--web-port'))
const dshPidfile = arg('--dsh-pidfile')
const dshCommand = arg('--dsh-command', 'dsh')
const dshHome = arg('--dsh-home')
const startedAt = Date.now()
let shuttingDown = false

function dshPid() {
  try {
    const value = Number(fs.readFileSync(dshPidfile, 'utf8').trim())
    return Number.isInteger(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

function dshRunning() {
  const pid = dshPid()
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function status() {
  return {
    v: 1,
    ok: true,
    running: dshRunning() && !shuttingDown,
    shuttingDown,
    pid: dshPid(),
    startedAt,
    uptimeMs: Date.now() - startedAt,
    profile,
    webPort,
    host: '127.0.0.1',
  }
}

function runtimeInfo() {
  let dshVersion = ''
  try {
    dshVersion = String(execFileSync(dshCommand, ['--version'], { encoding: 'utf8', timeout: 3000 })).trim().split(/\\r?\\n/)[0] || ''
  } catch { /* dsh 可能正在退出，版本只是附加信息 */ }
  return {
    v: 1,
    ok: true,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dshVersion,
    hostname: os.hostname(),
    cwd: process.cwd(),
    profileDir: dshHome ? dshHome.replace(/\\/+$/, '') + '/profiles/' + profile : '',
  }
}

function send(socket, value) {
  try { socket.write(JSON.stringify(value) + '\\n') } catch { /* 对端已断开 */ }
}

function handle(request) {
  if (!request || request.token !== token) return { v: 1, ok: false, error: 'unauthorized' }
  if (request.method === 'ping') return { v: 1, ok: true, pid: process.pid }
  if (request.method === 'getStatus') return status()
  if (request.method === 'getRuntimeInfo') return runtimeInfo()
  if (request.method === 'shutdown') {
    const pid = dshPid()
    shuttingDown = true
    setTimeout(() => {
      if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* 已经退出 */ } }
      setTimeout(() => process.exit(0), 300)
    }, 50)
    return { v: 1, ok: true, shuttingDown: true }
  }
  return { v: 1, ok: false, error: 'unknown method' }
}

const server = net.createServer((socket) => {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    if (buffer.length > 65536) { socket.destroy(); return }
    let index
    while ((index = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      let request = null
      try { request = JSON.parse(line) } catch { send(socket, { v: 1, ok: false, error: 'bad json' }); continue }
      send(socket, handle(request))
    }
  })
})
server.on('error', (error) => {
  console.error('dsh-x bridge: ' + (error && error.message ? error.message : error))
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => console.log('dsh-x bridge: 127.0.0.1:' + port))
process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500) })
process.on('SIGINT', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500) })
`

/** 插件/整合包代理：在 WSL 里复用 DSH-X 那套 plugins.js 与 packs.js。 */
export const WSL_HELPER_SCRIPT = `#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { listPlugins, setPluginEnabled, ensureBundleMounted } from './plugins.mjs'

const argv = process.argv.slice(2)
const action = argv[0] || ''
function arg(name, fallback = '') {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}
function emit(value) {
  console.log('__DSHX_JSON__' + JSON.stringify(value))
}
function log(line) {
  console.log('__DSHX_LOG__' + String(line))
}

const home = arg('--home', '')
const profile = arg('--profile', '')
const profileDir = home.replace(/\\/+$/, '') + '/profiles/' + profile
const dataDir = home.replace(/\\/+$/, '') + '/.dsh-x'
const fileArg = arg('--file', '')
const dsh = arg('--dsh', 'dsh') || 'dsh'
const pnpmArg = arg('--pnpm', '')
const hostProfile = arg('--host-profile', '')
const group = arg('--group', '')
const packNameArg = arg('--pack', '')

/** Windows 侧传来的整合包路径先通过 wslpath 转到 Linux 路径；目录形态也照常接受。 */
function wslPath(value) {
  const text = String(value || '')
  if (!text) return ''
  if (/^[A-Za-z]:[\\\\/]/.test(text) || text.startsWith('\\\\\\\\')) {
    try { return execFileSync('wslpath', ['-u', text], { encoding: 'utf8' }).trim() } catch { return text.replace(/\\\\/g, '/') }
  }
  return text
}

let pnpmDir = ''
/** WSL 里可能只有 Windows 互操作 PATH 里的 pnpm（/mnt/...），它不是 Linux 程序，dsh 调它会报盘符路径错误。 */
function findNativePnpm() {
  try {
    const output = execFileSync('bash', ['-lc', 'type -a -p pnpm 2>/dev/null || true'], { encoding: 'utf8' })
    return String(output).split(/\\r?\\n/).map((item) => item.trim()).find((item) => item.startsWith('/') && !item.startsWith('/mnt/')) || ''
  } catch {
    return ''
  }
}

/**
 * dsh plugin 只会在 PATH 里找 pnpm。发行版没装 pnpm 时，用 DSH-X 打包的 pnpm.js
 * 写一个只属于 WSL 用户的小包装（--pnpm 由 Windows 侧传入），避免误用 Windows 的 pnpm.exe。
 */
function ensurePnpm() {
  if (pnpmDir) return pnpmDir
  const native = findNativePnpm()
  if (native) {
    pnpmDir = native.slice(0, native.lastIndexOf('/'))
    return pnpmDir
  }
  const cli = wslPath(pnpmArg)
  if (!cli) return ''
  const bin = homedir() + '/.dsh-x/bin'
  try {
    mkdirSync(bin, { recursive: true })
    const wrapper = bin + '/pnpm'
    writeFileSync(wrapper, '#!/bin/sh\\nexec "' + process.execPath + '" "' + cli + '" "$@"\\n', { mode: 0o755 })
    chmodSync(wrapper, 0o755)
    pnpmDir = bin
  } catch {
    return ''
  }
  return pnpmDir
}

let packsModule = null
function packs() {
  if (!packsModule) packsModule = import('./packs.mjs')
  return packsModule
}

/** 插件列表之外还要把整合包安装记录带给 Windows 侧；读不到就当成没有记录。 */
function packRecords() {
  try {
    const state = JSON.parse(readFileSync(dataDir + '/packs/installed.json', 'utf8'))
    return Array.isArray(state && state.packs) ? state.packs : []
  } catch {
    return []
  }
}

async function loadPack() {
  const api = await packs()
  const file = wslPath(fileArg)
  if (!file) throw new Error('没有给整合包路径')
  if (existsSync(file) && statSync(file).isDirectory()) return { api, pack: api.parsePackDir(file), file }
  return { api, pack: api.parsePackArchive(await readFile(file)), file }
}

function planPayload(api, pack, plan) {
  return {
    pack: api.packSummary(pack),
    target: { profile: plan.profile, createsProfile: plan.createsProfile, profileDir: plan.profileDir },
    ok: plan.ok,
    plan: {
      notes: plan.notes,
      warnings: plan.warnings,
      errors: plan.errors,
      writes: plan.writes.map((write) => ({ rel: write.rel, kind: write.kind, note: write.note })),
    },
  }
}

function runDsh(args, cwd) {
  const command = /(^|[\\\\/])[^\\\\/]+\\.(?:c|m)?js$/.test(dsh) ? process.execPath : dsh
  const finalArgs = command === process.execPath ? [dsh, ...args] : args
  return new Promise((resolve, reject) => {
    const env = { ...process.env, DSH_HOME: home }
    const pnpm = ensurePnpm()
    if (pnpm) env.PATH = pnpm + ':' + (env.PATH || '')
    const child = spawn(command, finalArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        for (const line of String(chunk).split(/\\r?\\n/)) {
          if (line.trim()) log(line)
        }
      })
    }
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('dsh plugin 命令失败（退出码 ' + code + '）')))
  })
}

try {
  if (action === 'list') {
    const data = listPlugins(profileDir)
    emit({ ok: true, home, profile, packs: packRecords(), ...data })
  } else if (action === 'toggle') {
    const name = arg('--name')
    const enabled = arg('--enabled') === '1'
    const result = setPluginEnabled(profileDir, name, enabled)
    emit({ ok: true, home, profile, packs: packRecords(), changed: Boolean(result && result.changed), ...listPlugins(profileDir) })
  } else if (action === 'toggle-group') {
    const records = packRecords().filter((record) => record.profile === profile)
    const data = listPlugins(profileDir)
    const byName = new Map(data.plugins.map((plugin) => [plugin.name, plugin]))
    let names
    if (group === 'other') {
      const owned = new Set()
      for (const record of records) {
        for (const name of [...(record.bundles || []), ...Object.keys(record.dependencies || {}), ...Object.keys(record.specs || {})]) owned.add(String(name))
      }
      names = data.plugins.filter((plugin) => !plugin.official && !owned.has(plugin.name)).map((plugin) => plugin.name)
    } else if (packNameArg) {
      const record = records.find((item) => item.name === packNameArg)
      if (!record) throw new Error('profile「' + profile + '」没有「' + packNameArg + '」这条整合包记录')
      names = [...new Set([...(record.bundles || []).map(String), ...Object.keys(record.dependencies || {}), ...Object.keys(record.specs || {})])]
        .filter((name) => byName.has(name) && !byName.get(name).official)
    } else {
      names = data.plugins.filter((plugin) => !plugin.official).map((plugin) => plugin.name)
    }
    if (!names.length) throw new Error('这个分组里没有可切换的插件')
    let changed = 0
    const failed = []
    for (const name of names) {
      try {
        if (setPluginEnabled(profileDir, name, arg('--enabled') === '1').changed) changed += 1
      } catch (error) {
        failed.push(name + '：' + (error && error.message ? error.message : String(error)))
      }
    }
    emit({ ok: true, home, profile, packs: packRecords(), changed, failed, selected: names, pack: packNameArg, group: group || 'profile', ...listPlugins(profileDir) })
  } else if (action === 'pack-plan') {
    const { api, pack } = await loadPack()
    const target = profile || api.defaultProfileFor(pack)
    const plan = api.planInstall(pack, { home, profile: target, hostProfile })
    emit({ ok: true, home, profile: target, ...planPayload(api, pack, plan) })
  } else if (action === 'pack-install') {
    const { api, pack, file } = await loadPack()
    if (!pack.ok) throw new Error(pack.errors.join('；'))
    const target = profile || api.defaultProfileFor(pack)
    const targetDir = home.replace(/\\/+$/, '') + '/profiles/' + target
    const plan = api.planInstall(pack, { home, profile: target, hostProfile })
    if (!plan.ok) throw new Error(plan.errors.join('；'))
    const records = packRecords().filter((record) => record.profile === target)
    const previousRecord = records.find((record) => record.name === pack.fields.name)
    if (previousRecord && previousRecord !== records.at(-1)) throw new Error('这个整合包后面还安装了其他包，请先撤销后续安装再重装')
    log('安装整合包 ' + pack.fields.name + ' ' + pack.fields.version + ' → profile ' + target)
    const result = await api.applyInstall(plan, {
      home,
      dataDir,
      pack,
      source: file,
      previousRecord,
      runInstall: async (targetProfile) => {
        await runDsh(['plugin', '--profile', targetProfile, 'install', '--config.auto-install-peers=false'], targetDir)
      },
      log,
    })
    api.rememberPack(dataDir, result.record)
    emit({
      ok: true,
      home,
      profile: target,
      installed: result.record,
      plan: { notes: plan.notes, warnings: plan.warnings, writes: plan.writes.map((write) => write.rel) },
      packs: packRecords(),
      ...listPlugins(targetDir),
    })
  } else if (action === 'pack-uninstall') {
    const api = await packs()
    const name = arg('--name')
    const records = packRecords().filter((record) => record.profile === profile)
    const record = records.find((item) => item.name === name)
    if (!record) throw new Error('没有「' + name + ' 装在 ' + profile + '」这条安装记录')
    if (record !== records.at(-1)) throw new Error('请先撤销最近安装的整合包「' + (records.at(-1).displayName || records.at(-1).name) + '」')
    const result = api.uninstallPack(record, { home, log })
    api.forgetPack(dataDir, name, profile)
    log('整合包 ' + name + ' 已从 profile「' + profile + '」卸下（还原 ' + result.restored + ' 个文件）')
    emit({ ok: true, home, profile, restored: result.restored, packs: packRecords(), ...listPlugins(profileDir) })
  } else if (action === 'plugin-add') {
    const spec = arg('--spec')
    if (!spec) throw new Error('没有给插件名')
    await runDsh(['plugin', '--profile', profile, 'add', '-w', spec], profileDir)
    const mounted = ensureBundleMounted(profileDir, spec)
    emit({ ok: true, home, profile, packs: packRecords(), spec, mounted: mounted.ok ? Boolean(mounted.changed) : false, ...listPlugins(profileDir) })
  } else {
    emit({ ok: false, error: 'unknown action' })
    process.exitCode = 2
  }
} catch (error) {
  emit({ ok: false, error: error && error.message ? error.message : String(error) })
  process.exitCode = 1
}
`
