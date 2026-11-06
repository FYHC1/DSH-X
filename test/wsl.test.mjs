import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { WSL_AGENT_SCRIPT, WSL_SYSTEMD_SCRIPT } from '../src/wsl-scripts.js'
import { safeLaunchPresets, safeWslServiceMode } from '../src/settings.js'
import {
  DEFAULT_HOME,
  WSL_SERVICE_MODE,
  WSL_SERVICE_MODES,
  decodeWslOutput,
  normalizeWslServiceMode,
  parseWslDistroList,
  parseWslHomeKey,
  resolveWslHome,
  wslAvailable,
  wslHomeKey,
  buildAgentInstallScript,
} from '../src/wsl.js'

// WSL 相关纯函数测试：不启动真实 wsl.exe，保证 macOS / Linux 开发机和 CI 也能跑。

function functionSource(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, '找不到函数 ' + name)
  const brace = source.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('函数没有闭合：' + name)
}

test('WSL 的实例键可以往返，发行版与用户目录都按 URI 编码', () => {
  assert.equal(DEFAULT_HOME, '~/.dsh')
  assert.equal(wslHomeKey('Fedora', '~/.dsh'), 'wsl://Fedora/~%2F.dsh')
  assert.deepEqual(parseWslHomeKey('wsl://Fedora/~%2F.dsh'), { distro: 'Fedora', home: '~/.dsh' })
  assert.deepEqual(parseWslHomeKey(wslHomeKey('Ubuntu 24.04', '/home/a b/.dsh')), { distro: 'Ubuntu 24.04', home: '/home/a b/.dsh' })
})

test('坏的实例键当成本机路径处理，不能把停止流程带崩', () => {
  assert.equal(parseWslHomeKey(''), null)
  assert.equal(parseWslHomeKey('C:\Users\a\.dsh'), null)
  assert.equal(parseWslHomeKey('wsl://Fedora/%E0%A4%A'), null)
})

test('WSL 用户目录只接受 ~ 或绝对路径，末尾斜杠归一化', () => {
  assert.equal(resolveWslHome(''), '~/.dsh')
  assert.equal(resolveWslHome('~'), '~')
  assert.equal(resolveWslHome('~/work/'), '~/work')
  assert.equal(resolveWslHome('/root/.dsh/'), '/root/.dsh')
  assert.equal(resolveWslHome('/'), '/')
  assert.throws(() => resolveWslHome('relative/path'), /绝对路径/)
})

test('wsl --list --verbose 解析：默认发行版、Running/Stopped、名字里有空格都能认', () => {
  const text = [
    '  NAME            STATE           VERSION',
    '* Fedora          Running         2',
    '  Ubuntu 24.04    Stopped         2',
    '  docker-desktop  Running         2',
    '  podman-machine-default  Stopped  2',
    '',
  ].join('\r\n')
  assert.deepEqual(parseWslDistroList(text), [
    { name: 'Fedora', state: 'Running', version: 2, default: true },
    { name: 'Ubuntu 24.04', state: 'Stopped', version: 2, default: false },
  ])
})

test('中文 Windows 的 wsl --list 表头与状态不影响解析，发行版名可以是任意语言', () => {
  const text = [
    '  名称        状态       版本',
    '* 我的发行版  运行中     2',
    '  Ubuntu-24.04 已停止     1',
    '  Debian       Stopped    2',
    '',
  ].join('\r\n')
  assert.deepEqual(parseWslDistroList(text), [
    { name: '我的发行版', state: '运行中', version: 2, default: true },
    { name: 'Ubuntu-24.04', state: '已停止', version: 1, default: false },
    { name: 'Debian', state: 'Stopped', version: 2, default: false },
  ])
})

test('wsl.exe 的 UTF-16LE 输出能解码，普通 UTF-8 不被误判', () => {
  const text = '  NAME  STATE  VERSION\r\n* Fedora  Running  2\r\n'
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  assert.match(decodeWslOutput(utf16), /Fedora/)
  assert.match(decodeWslOutput(Buffer.from('Fedora Running', 'utf8')), /^Fedora Running$/)
  assert.equal(decodeWslOutput(Buffer.alloc(0)), '')
})

test('wrapper 脚本：pidfile 按实例区分，前台 exec dsh，停止先 TERM 再按端口兜底', () => {
  assert.equal(WSL_SERVICE_MODE, 'wrapper')
  assert.match(WSL_AGENT_SCRIPT, /run_dir="\$state_dir\/run"/)
  assert.match(WSL_AGENT_SCRIPT, /pidfile="\$run_dir\/\$id\.pid"/)
  assert.match(WSL_AGENT_SCRIPT, /--host 127\.0\.0\.1/)
  assert.match(WSL_AGENT_SCRIPT, /--port/)
  assert.match(WSL_AGENT_SCRIPT, /--no-open/)
  assert.match(WSL_AGENT_SCRIPT, /stop_pid "\$pid"/)
  // 端口兜底要核对命令行，不能只按端口 fuser -k：端口会被别的服务复用。
  assert.match(WSL_AGENT_SCRIPT, /fuser -n tcp "\$port"/)
  assert.match(WSL_AGENT_SCRIPT, /\*dsh\*"--port \$port"\*/)
  assert.doesNotMatch(WSL_AGENT_SCRIPT, /fuser -k -TERM/)
})

test('wslAvailable 只返回布尔值，不抛异常', () => {
  assert.equal(typeof wslAvailable(), 'boolean')
})

test('WSL 启动脚本安装：按发行版加锁、临时文件原子替换、内容没变不动目标', () => {
  const script = buildAgentInstallScript('#!/bin/bash\necho hello\n')
  assert.match(script, /mkdir "\$lock"/)
  assert.match(script, /trap 'cleanup' EXIT/)
  assert.match(script, /sha256sum "\$target"/)
  assert.match(script, /mv -f "\$tmp" "\$target"/)
  assert.match(script, /tmp="\$target\.tmp\.\$\$"/)
  const digest = createHash('sha256').update('#!/bin/bash\necho hello\n').digest('hex')
  assert.match(script, new RegExp(digest))
  assert.equal(buildAgentInstallScript('x', '../evil').includes('../evil'), false)
})

test('bootWslOnce 在 finally 释放 rememberedWslPort 认领的自动端口', () => {
  // WSL 实例没法在 CI 里真起；用源码结构锁住「认领 → 必须释放」这条回归点。
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function bootWslOnce')
  const end = source.indexOf('/** 从 WSL 里已安装的 dsh 起一个实例', start)
  const body = source.slice(start, end)
  assert.match(body, /const reused = remembered\.port/)
  assert.match(body, /finally \{\s*claimedAutoPorts\.delete\(reused\)\s*\}/)
})

test('launchInstalled / restartInstalled 保留 launchId、服务模式与 auto 版本', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const launch = functionSource(source, 'launchInstalled')
  assert.match(launch, /launchScopeOfInstance\(live, preset\)/)
  assert.match(launch, /launchVersionOfInstance\(live, preset\)/)
  assert.match(launch, /attached: live\.attached === true/)
  const restart = functionSource(source, 'restartInstalled')
  assert.match(restart, /launchId: proc\.launchId \|\| preset\?\.id \|\| ''/)
  assert.match(restart, /wslPort: proc\.wslPort \|\| 0/)
  assert.match(restart, /wslWorkdir, wslPort,/)
  assert.match(restart, /wslServiceMode: WSL_SERVICE_MODES\.includes\(serviceMode\)/)
  assert.match(functionSource(source, 'bootWslOnce'), /remembered\.port \|\| \(Number\(context\.wslPort\) \|\| 0\)/)
  assert.match(source, /function launchVersionOfInstance\(proc, preset\) \{[\s\S]*?preset\?\.version === 'auto' \? 'auto' : proc\.version/)
})

test('WSL 心跳能把 error 恢复为 running，systemd 日志跟随器退出不删实例', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const tick = functionSource(source, 'wslHeartbeatTick')
  assert.match(tick, /if \(proc\.status === 'error'\) \{[\s\S]*?proc\.status = 'running'/)
  const attach = functionSource(source, 'attachProcess')
  assert.match(attach, /proc\.backend === 'wsl' && proc\.serviceMode === 'systemd' && proc\.status === 'running'/)
  assert.match(attach, /proc\.journalExited = true/)
})

test('WSL 停止后用端口探针确认，不能只信脚本退出码', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const terminate = functionSource(source, 'terminateProcess')
  assert.match(terminate, /const verifyWslStopped = async \(\) =>/)
  assert.match(terminate, /probeWslDshPort\(proc\.distro, proc\.wslPort\)/)
  assert.match(terminate, /return verifyWslStopped\(\)/)
})

test('外部 dsh 停止按端口和命令行双重核对，TERM 不退再升级 KILL', () => {
  const source = readFileSync(new URL('../src/wsl.js', import.meta.url), 'utf8')
  const stop = functionSource(source, 'stopWslExternal')
  assert.match(stop, /\*dsh\*"--port \$port"\*/)
  assert.match(stop, /\*dsh\*" web"\*/)
  assert.match(stop, /kill -KILL "\$pid"/)
})

test('服务模式只认 wrapper / systemd，未知值回 wrapper', () => {
  assert.deepEqual(WSL_SERVICE_MODES, ['wrapper', 'systemd'])
  assert.equal(normalizeWslServiceMode('wrapper'), 'wrapper')
  assert.equal(normalizeWslServiceMode('systemd'), 'systemd')
  assert.equal(normalizeWslServiceMode('systemd '), 'wrapper')
  assert.equal(normalizeWslServiceMode(''), 'wrapper')
  assert.equal(safeWslServiceMode('systemd'), 'systemd')
  assert.equal(safeWslServiceMode('bad'), 'wrapper')
})

test('启动项服务模式空串保留为跟随全局，不落成显式 wrapper', () => {
  const base = { id: 'a'.repeat(16), name: 'WSL 环境', version: 'auto', profile: 'web', port: 0, backend: 'wsl', wslDistro: 'Fedora' }
  const pick = (entry) => safeLaunchPresets([entry]).find((item) => item.id === base.id)
  // 老启动项没有字段：解析成默认 wrapper，保持旧行为。
  assert.equal(pick(base).wslServiceMode, 'wrapper')
  // 用户显式选「跟随全局」：字段必须消失，之后改全局默认才能生效。
  assert.equal('wslServiceMode' in pick({ ...base, wslServiceMode: '' }), false)
  assert.equal(pick({ ...base, wslServiceMode: 'systemd' }).wslServiceMode, 'systemd')
})

test('startSystemdInstance 把端口和 dsh 命令传给 systemd 脚本', () => {
  const source = readFileSync(new URL('../src/wsl.js', import.meta.url), 'utf8')
  const start = functionSource(source, 'startSystemdInstance')
  assert.match(start, /String\(port\), options\.dshCommand \|\| 'dsh'/, 'systemd 脚本的 start 需要第 5 个参数端口')
})

test('systemd 启动失败回收 unit，停止脚本抛错也杀 keepalive', () => {
  const source = readFileSync(new URL('../src/wsl.js', import.meta.url), 'utf8')
  const start = functionSource(source, 'startWslInstance')
  assert.match(start, /await stopWslInstance\(\{ distro, instanceId, port, serviceMode: 'systemd' \}\)\.catch\(\(\) => \{\}\)/)
  const stop = functionSource(source, 'stopWslInstance')
  assert.match(stop, /\} finally \{[\s\S]*options\.keepalive\?\.kill\('SIGKILL'\)/)
})

test('systemd 脚本：user unit 用专用 unit 名，前台 exec dsh，停止会停 unit', () => {
  assert.match(WSL_SYSTEMD_SCRIPT, /unit_dir="\$HOME\/\.config\/systemd\/user"/)
  assert.match(WSL_SYSTEMD_SCRIPT, /dsh-x-\$id\.service/)
  assert.match(WSL_SYSTEMD_SCRIPT, /Restart=on-failure/)
  assert.match(WSL_SYSTEMD_SCRIPT, /KillMode=control-group/)
  assert.match(WSL_SYSTEMD_SCRIPT, /systemctl --user start/)
  // --no-block + 轮询 + SIGKILL 兜底：不能出现 Windows 侧超时了 unit 还在跑的状态。
  assert.match(WSL_SYSTEMD_SCRIPT, /systemctl --user stop --no-block/)
  assert.match(WSL_SYSTEMD_SCRIPT, /systemctl --user kill --signal=SIGKILL/)
  assert.match(WSL_SYSTEMD_SCRIPT, /exec \$\(printf '%q' "\$dsh_cmd"\)/)
})
