/**
 * dsh-obmc-web — host half.
 *
 * Registers same-origin proxy routes on the DSH web server that forward to
 * the AST2700 EVB BMC through the obmc-web-relay.service SSH tunnel
 * (https://127.0.0.1:18443, loopback only). The BMC's web UI (bmcweb) is a
 * hash-router SPA whose index references ROOT-ABSOLUTE assets and APIs
 * (/js/…, /css/…, /redfish/…, /login, /logout), so the proxy owns those
 * exact root path families; the web server dispatches longest-prefix-wins
 * after its own exact table, so the GUI's own longer routes always win and
 * a duplicate registration is skipped (never throws the plugin).
 *
 * Embed-hostile response headers are removed (X-Frame-Options, HSTS,
 * CSP frame-ancestors — and WWW-Authenticate, so bmcweb's 401 Basic
 * challenges can never pop the browser's native credential dialog; the BMC
 * SPA logs in via POST /login JSON + cookie). Everything else passes
 * through untouched; no credentials are stored anywhere.
 *
 * BMC address discovery: the BMC's address is often DHCP-assigned by the
 * jump host that links it (a small LAN of its own) and may change. When
 * the tunnel target stops answering (proxy upstream error, or a live probe
 * of /bmc-status), the host SSHes to the configured jump host
 * (OBMC_SSH_TARGET in the relay env file, BatchMode key assumed present)
 * and locates the bmcweb speaker: dnsmasq lease file + ARP table first,
 * full TCP-443 sweep as fallback, each candidate fingerprinted by its
 * /redfish/v1 response. The winner is written back to the env file
 * (BMC_TARGET, consumed by the relay unit's EnvironmentFile) and the relay
 * is restarted through the user manager; the switch is verified through
 * the tunnel before being reported. Manual trigger: POST /bmc-status.
 * Discovery is entirely optional: with no OBMC_SSH_TARGET the proxy still
 * works, it just cannot retarget itself.
 *
 * All site-specific values (BMC address, SSH jump host, link subnet, relay
 * port) live in the env file — nothing about your network is hardcoded
 * here. On first start a commented template is generated; the Settings
 * panel's deployment form reads/edits the same keys through
 * GET/POST /bmc-config and can install/restart the relay unit
 * (POST /bmc-relay-install), so a fresh machine is usable without touching
 * a shell.
 *
 * The trust fence mirrors dsh-better-sidebar's trust-fence.ts: Host must
 * be loopback or a deployment-trusted authority, Sec-Fetch-Site must not
 * be cross-site, and a present Origin must name the Host's hostname. It is
 * a DNS-rebinding / cross-site defense, not authentication — the routes
 * sit behind whatever gate the deployment already puts in front of the
 * GUI (dsh-auth-caddy etc.) and the server itself binds loopback only.
 */
import https from 'node:https'
import net from 'node:net'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = '@iasiv5/dsh-obmc-web'
export const inject = ['webServer', 'webRuntime']

const UP_HOST = '127.0.0.1'
const DEFAULT_RELAY_PORT = 18443
// Deployment config: a KEY=VALUE env file shared with the relay unit (its
// EnvironmentFile). Override the location with the OBMC_WEB_ENV env var.
// Auto-generated as a commented template on first start; editable by hand
// or from the Settings form (GET/POST /bmc-config).
const ENV_FILE = process.env.OBMC_WEB_ENV
  ?? path.join(os.homedir(), '.config/systemd/user/obmc-relay.env')
const UNIT_NAME = 'obmc-web-relay.service'
// Test-isolation knob mirroring OBMC_WEB_ENV: point it elsewhere in tests
// so they can never touch the real user unit.
const UNIT_DIR = process.env.OBMC_UNIT_DIR ?? path.join(os.homedir(), '.config/systemd/user')
const unitPath = () => path.join(UNIT_DIR, UNIT_NAME)
const DISCOVERY_COOLDOWN_MS = 60_000

// Validated at load time; unknown/invalid keys are ignored.
const envConfig = {
  bmcTarget: null,   // 'ip:port' | null — informational + discovery baseline
  sshTarget: null,   // 'user@host' | null — discovery disabled when null
  sshPort: 22,
  subnet: null,      // 'a.b.c' — defaults to the bmcTarget IP's /24
  relayPort: DEFAULT_RELAY_PORT,
}

const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])
// www-authenticate is dropped so bmcweb's 401 Basic challenges (e.g. on
// /login and unknown paths) can never pop the browser's native credential
// dialog — the BMC SPA logs in via POST /login JSON + cookie, not Basic.
const DROP_RESPONSE = new Set([...HOP, 'x-frame-options', 'strict-transport-security', 'www-authenticate'])

const agent = new https.Agent({ keepAlive: true, maxSockets: 8, rejectUnauthorized: false })

// ── BMC target state + discovery ─────────────────────────────────────────
const bmcState = {
  target: null,             // 'ip:port' | null — from the relay env file
  phase: 'idle',            // idle | discovering | ok | failed
  lastError: null,
  lastUpstreamError: null,  // epoch ms of the most recent proxy upstream error
  lastDiscovery: null,      // { at, found, previous, switched, verified }
  startedAt: Date.now(),
}
let discovering = false
let lastDiscoveryAt = 0

function isValidBmcTarget(value) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(:\d{1,5})?$/.exec(value)
  if (!match) return false
  return match[1].split('.').every(octet => Number(octet) <= 255)
}

function isValidSshTarget(value) {
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.\[\]-]+$/.test(value)
}

function isValidSubnet(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  return match !== null && [match[1], match[2], match[3]].every(octet => Number(octet) <= 255)
}

function isValidPort(value) {
  return /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65_535
}

/** Accept 'ip' or 'ip:port'; normalize to 'ip:port' or null. */
function normalizeBmcTarget(value) {
  const withPort = value.includes(':') ? value : `${value}:443`
  return isValidBmcTarget(withPort) ? withPort : null
}

/** Parse the relay env file; invalid values are skipped, never trusted. */
function readEnvConfig() {
  const config = { bmcTarget: null, sshTarget: null, sshPort: 22, subnet: null, relayPort: DEFAULT_RELAY_PORT }
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8')
    for (const line of text.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (!match) continue
      const key = match[1]
      const value = match[2].trim()
      if (key === 'BMC_TARGET' && isValidBmcTarget(value)) config.bmcTarget = value
      else if (key === 'OBMC_SSH_TARGET' && isValidSshTarget(value)) config.sshTarget = value
      else if (key === 'OBMC_SSH_PORT' && isValidPort(value)) config.sshPort = Number(value)
      else if (key === 'OBMC_SUBNET' && isValidSubnet(value)) config.subnet = value
      else if (key === 'OBMC_RELAY_PORT' && isValidPort(value)) config.relayPort = Number(value)
    }
  } catch {
    // No config file: the proxy still works through the tunnel as-is,
    // discovery just stays off until OBMC_SSH_TARGET appears.
  }
  if (config.subnet === null && config.bmcTarget !== null) {
    config.subnet = config.bmcTarget.split(':')[0].split('.').slice(0, 3).join('.')
  }
  return config
}

/**
 * Update the given KEY=VALUE lines in place, preserving comments, ordering
 * and every unknown key. Keys not yet present are appended at the end.
 */
function updateEnvFile(updates) {
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true })
  let text = ''
  try { text = fs.readFileSync(ENV_FILE, 'utf8') } catch { /* first write */ }
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`
    const pattern = new RegExp(`^${key}=.+$`, 'm')
    if (pattern.test(text)) text = text.replace(pattern, line)
    else text = (text === '' || text.endsWith('\n') ? text : text + '\n') + line + '\n'
  }
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 })
}

function writeTargetEnvFile(ip) {
  updateEnvFile({ BMC_TARGET: `${ip}:443` })
}

/** First-start bootstrap: a fully commented template, nothing enabled. */
function ensureEnvTemplate() {
  if (fs.existsSync(ENV_FILE)) return false
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true })
  fs.writeFileSync(ENV_FILE, `# @iasiv5/dsh-obmc-web 部署配置（首次启动自动生成，全部为注释态）
# 推荐在 DSH「设置 → BMC 控制台」的部署配置表单里填写，保存后自动写入本文件；
# 也可以手动编辑（改完重启 dsh web 生效）。格式 KEY=VALUE，未知键会被忽略。
#
# BMC 地址（ip 或 ip:port，端口缺省 443；下面是文档专用示例地址，请改成你的）
#BMC_TARGET=192.0.2.10:443
#
# —— 以下为 SSH 自动探测（可选）：BMC 的 IP 被 DHCP 改变后自动找回 ——
# 跳板机：与 BMC 链路网段相通、已配好免密登录（BatchMode）的机器
#OBMC_SSH_TARGET=user@jump.example.net
#OBMC_SSH_PORT=22
# 链路网段（缺省取 BMC IP 的 /24）
#OBMC_SUBNET=192.0.2
#
# relay 本地监听端口（需与 relay unit 的 -L 参数一致，默认 18443）
#OBMC_RELAY_PORT=18443
`, { mode: 0o600 })
  return true
}

/** True when something already listens on 127.0.0.1:port. */
function portInUse(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(true))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(false)))
  })
}

/** One HTTPS request through the tunnel; resolves { ok, status }. */
function tunnelRequest(requestPath, timeoutMs = 8000) {
  return new Promise(resolve => {
    const request = https.request(
      { host: UP_HOST, port: envConfig.relayPort, method: 'GET', path: requestPath, agent, timeout: timeoutMs },
      response => {
        response.resume()
        resolve({ ok: response.statusCode === 200 || response.statusCode === 401, status: response.statusCode })
      },
    )
    request.on('timeout', () => { request.destroy(); resolve({ ok: false, status: 0 }) })
    request.on('error', () => resolve({ ok: false, status: 0 }))
    request.end()
  })
}

function userEnv() {
  const runtimeDir = `/run/user/${process.getuid ? process.getuid() : 1000}`
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
  }
}

function systemdManagerCall(args) {
  return new Promise((resolve, reject) => {
    execFile('busctl', ['--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager', ...args], { env: userEnv(), timeout: 20_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** systemd unit state: 'active' | 'inactive' | 'failed' | … | 'unknown'. */
function relayActiveState() {
  return new Promise(resolve => {
    execFile('systemctl', ['--user', 'is-active', UNIT_NAME], { env: userEnv(), timeout: 5_000 },
      (error, stdout) => resolve(String(stdout).trim() || 'unknown'))
  })
}

/** The user-level unit file, generated from the current validated config. */
function generateUnit(config) {
  return `[Unit]
Description=SSH local-forward relay to the BMC Web UI (managed by @iasiv5/dsh-obmc-web)
# Local port ${config.relayPort} -> (over ssh to the jump host) -> BMC $BMC_TARGET
# Binds loopback only. BMC_TARGET lives in the shared env file and is
# rewritten in place by the plugin's SSH discovery.
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=BMC_TARGET=${config.bmcTarget}
EnvironmentFile=-${ENV_FILE}
ExecStart=/usr/bin/ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o BatchMode=yes -N -L 127.0.0.1:${config.relayPort}:\${BMC_TARGET} -p ${config.sshPort} ${config.sshTarget}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
}

/** Small JSON request body reader (8 KB cap). */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 8192) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Locate the bmcweb speaker from the jump host: dnsmasq leases + ARP table
 * first (sub-second when the BMC is merely renumbered), full TCP-443 sweeps
 * of the candidate /24s as fallback. Every candidate is fingerprinted by
 * its /redfish/v1 answer, so generous candidate lists are safe. With a
 * validated subnet the sweep is scoped to it; with null the jump host
 * enumerates its own directly-connected IPv4 /24s (bootstrap mode — no
 * site data is interpolated either way, the body stays fixed).
 */
function buildDiscoveryScript(subnet) {
  const subnetsSource = subnet
    ? `"${subnet}"`
    : '"$(ip -4 -o addr show scope global 2>/dev/null | awk \'{split($4,a,"/"); print a[1]}\' | awk -F. \'{OFS="."} NF==4 {print $1,$2,$3}\' | sort -u)"'
  return `# dsh-obmc-web BMC discovery on the jump host
lease_files="/var/lib/misc/dnsmasq.leases /var/lib/dnsmasq/dnsmasq.leases"
SUBNETS=${subnetsSource}
cands=""
for f in $lease_files; do
  [ -r "$f" ] && cands="$cands $(awk '{print $3}' "$f" 2>/dev/null)"
done
cands="$cands $(ip neigh show 2>/dev/null | awk '{print $1}' | grep -E '^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.)' | head -100)"
cands=$(printf '%s\\n' $cands | sort -u)
check() { code=$(curl -k -m 3 -s -o /dev/null -w '%{http_code}' "https://$1/redfish/v1" 2>/dev/null); [ "$code" = 200 ] || [ "$code" = 401 ]; }
for c in $cands; do
  if check "$c"; then echo "BMC_IP=$c"; exit 0; fi
done
for SUBNET in $SUBNETS; do
  live=$(seq 2 254 | xargs -P 32 -I{} sh -c "nc -z -w1 $SUBNET.{} 443 2>/dev/null && echo $SUBNET.{}" 2>/dev/null)
  for c in $(printf '%s\\n' $live | sort -u); do
    if check "$c"; then echo "BMC_IP=$c"; exit 0; fi
  done
done
echo "BMC_IP="
`
}

function runDiscoveryScript() {
  const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-p', String(envConfig.sshPort), envConfig.sshTarget]
  return new Promise(resolve => {
    const child = spawn('ssh', [...sshArgs, 'sh -s'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(timer); resolve({ error: error.message }) })
    child.on('close', code => {
      clearTimeout(timer)
      const match = /BMC_IP=(\d{1,3}(?:\.\d{1,3}){3})/.exec(stdout)
      const found = match ? match[1] : null
      if (found !== null && !isValidBmcTarget(`${found}:443`)) resolve({ error: 'implausible candidate ignored', found: null })
      else resolve({ found, code, stderr: stderr.slice(0, 400) })
    })
    child.stdin.end(buildDiscoveryScript(envConfig.subnet))
  })
}

async function relayRestart() {
  await systemdManagerCall(['Reload'])
  await systemdManagerCall(['RestartUnit', 'ss', UNIT_NAME, 'replace'])
  // Give ssh a moment to establish and the port to re-listen.
  for (let waited = 0; waited < 12_000; waited += 1_000) {
    await new Promise(resolve => setTimeout(resolve, 1_000))
    if ((await tunnelRequest('/redfish/v1', 4_000)).ok) return true
  }
  return false
}

async function switchTunnelTarget(ip) {
  writeTargetEnvFile(ip)
  return relayRestart()
}

async function discoverBmc(manual) {
  if (envConfig.sshTarget === null) {
    return { started: false, reason: 'discovery not configured: fill SSH 跳板机 (OBMC_SSH_TARGET) in the config form first' }
  }
  if (discovering) return { started: false, reason: 'already running' }
  if (!manual && Date.now() - lastDiscoveryAt < DISCOVERY_COOLDOWN_MS) {
    return { started: false, reason: 'cooldown' }
  }
  discovering = true
  lastDiscoveryAt = Date.now()
  bmcState.phase = 'discovering'
  const previous = bmcState.target
  // Fire and forget: the UI polls /bmc-status for phase transitions.
  ;(async () => {
    try {
      const result = await runDiscoveryScript()
      if (!result.found) {
        bmcState.phase = 'failed'
        bmcState.lastError = result.error || `no bmcweb speaker found on the jump host (${previous})`
        return
      }
      const switched = `${result.found}:443` !== previous
      let verified = false
      if (switched) {
        bmcState.target = `${result.found}:443`
        verified = await switchTunnelTarget(result.found)
      } else {
        verified = (await tunnelRequest('/redfish/v1')).ok
        if (!verified) verified = await switchTunnelTarget(result.found)
      }
      bmcState.lastDiscovery = {
        at: Date.now(), found: result.found, previous,
        switched: switched && verified, verified,
      }
      bmcState.phase = verified ? 'ok' : 'failed'
      if (!verified) bmcState.lastError = `found ${result.found} but the tunnel switch did not verify`
    } catch (error) {
      bmcState.phase = 'failed'
      bmcState.lastError = error.message
    } finally {
      discovering = false
    }
  })()
  return { started: true }
}

// ── trust fence (mirror of dsh-better-sidebar's trust-fence.ts) ──────────
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function trustedRequest(req, trustedHosts) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  const trusted = trustedHosts.some(entry => {
    try {
      const entryUrl = new URL(`http://${entry}`)
      const withPort = entryUrl.port !== ''
      return withPort
        ? `${entryUrl.hostname}:${entryUrl.port}` === hostUrl.host
        : entryUrl.hostname === hostUrl.hostname
    } catch { return false }
  })
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** Rewrite one CSP value: keep every directive except frame-ancestors. */
function cspWithoutFrameAncestors(value) {
  return value.split(';')
    .map(directive => directive.trim())
    .filter(directive => directive !== '' && !directive.toLowerCase().startsWith('frame-ancestors'))
    .join('; ')
}

/** Forward one plain HTTP exchange to the BMC tunnel. */
function proxyRequest(req, res, targetPath, log) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP.has(key.toLowerCase()) || key.toLowerCase() === 'host') continue
    headers[key] = value
  }
  headers.host = `${UP_HOST}:${envConfig.relayPort}`
  const upstream = https.request(
    { host: UP_HOST, port: envConfig.relayPort, method: req.method, path: targetPath, headers, agent },
    (up) => {
      const raw = []
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        const key = up.rawHeaders[i]
        const value = up.rawHeaders[i + 1]
        const lower = key.toLowerCase()
        if (DROP_RESPONSE.has(lower)) continue
        if (lower === 'content-security-policy') {
          const rewritten = cspWithoutFrameAncestors(value)
          if (rewritten === '') continue
          raw.push(key, rewritten)
          continue
        }
        raw.push(key, value)
      }
      res.writeHead(up.statusCode, raw)
      up.pipe(res)
    },
  )
  upstream.on('error', error => {
    bmcState.lastUpstreamError = Date.now()
    log?.warn?.(`[dsh-obmc-web] upstream error for ${targetPath}: ${error.message}`)
    try {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-obmc-web: BMC relay tunnel unavailable (is obmc-web-relay.service running?)')
    } catch { /* socket already gone */ }
    // The tunnel target stopped answering: locate the BMC's current address.
    discoverBmc(false).catch(() => {})
  })
  req.pipe(upstream)
}

/** Tunnel one WebSocket upgrade straight through to the BMC (kvm/console). */
function proxyUpgrade(req, socket, head, log) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === 'host') continue
    headers[key] = value
  }
  headers.host = `${UP_HOST}:${envConfig.relayPort}`
  const upstream = https.connect({ host: UP_HOST, port: envConfig.relayPort, rejectUnauthorized: false }, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`)
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head !== undefined && head.length > 0) upstream.write(head)
    upstream.on('close', () => socket.destroy())
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    socket.on('error', () => upstream.destroy())
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', error => {
    log?.warn?.(`[dsh-obmc-web] upgrade tunnel error: ${error.message}`)
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    socket.destroy()
  })
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

export function apply(ctx) {
  const createdTemplate = ensureEnvTemplate()
  if (createdTemplate) ctx.logger?.info?.(`[dsh-obmc-web] first start: wrote a commented config template to ${ENV_FILE} — configure it in Settings → BMC 控制台`)
  Object.assign(envConfig, readEnvConfig())
  bmcState.target = envConfig.bmcTarget
  const trustedHostsOf = () => Array.isArray(ctx.webRuntime?.trustedHosts) ? ctx.webRuntime.trustedHosts : []
  const fence = req => trustedRequest(req, trustedHostsOf())
  const guarded = handler => (req, res) => {
    if (!fence(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-obmc-web: forbidden')
      return
    }
    handler(req, res)
  }

  const register = (route, label) => {
    try {
      ctx.effect(() => ctx.webServer.register(route), label)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-obmc-web] skipped ${label}: ${error.message}`)
    }
  }

  // Status + manual discovery trigger: GET returns the live tunnel verdict
  // and the current target; POST starts an SSH discovery round.
  register({
    kind: 'exact',
    path: '/bmc-status',
    handler: guarded((req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      if (req.method === 'POST') {
        discoverBmc(true).then(result => writeJson(res, 202, result))
          .catch(() => writeJson(res, 500, { started: false }))
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false })
        return
      }
      const live = url.searchParams.get('probe') === '1'
        ? awaitTunnelProbe()
        : Promise.resolve(null)
      live.then(probe => writeJson(res, 200, {
        target: bmcState.target,
        phase: bmcState.phase,
        discoveryConfigured: envConfig.sshTarget !== null,
        ok: probe ? probe.ok : null,
        probeStatus: probe ? probe.status : null,
        lastError: bmcState.lastError,
        lastUpstreamError: bmcState.lastUpstreamError,
        lastDiscovery: bmcState.lastDiscovery,
        discovering,
        uptimeMs: Date.now() - bmcState.startedAt,
      }))
    }),
  }, 'dsh-obmc-web: /bmc-status')

  // Deployment config: read current values + relay unit state; save the
  // Settings form's values into the shared env file (validated, in-place,
  // comments preserved). Tunnel-affecting changes restart a running relay.
  const publicConfig = () => ({
    bmcTarget: envConfig.bmcTarget,
    sshTarget: envConfig.sshTarget,
    sshPort: envConfig.sshPort,
    subnet: envConfig.subnet,
    relayPort: envConfig.relayPort,
  })
  const relayInfo = () => relayActiveState().then(active => ({ installed: fs.existsSync(unitPath()), active }))
  register({
    kind: 'exact',
    path: '/bmc-config',
    handler: guarded((req, res) => {
      if (req.method === 'GET') {
        relayInfo().then(relay => writeJson(res, 200, { envFile: ENV_FILE, config: publicConfig(), relay }))
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false })
        return
      }
      readJsonBody(req).then(body => {
        const updates = {}
        const errors = []
        if (body.bmcTarget !== undefined && body.bmcTarget !== '') {
          const normalized = normalizeBmcTarget(String(body.bmcTarget).trim())
          if (normalized === null) errors.push('BMC 地址格式无效（期望 ip 或 ip:port）')
          else updates.BMC_TARGET = normalized
        }
        if (body.sshTarget !== undefined && body.sshTarget !== '') {
          const value = String(body.sshTarget).trim()
          if (!isValidSshTarget(value)) errors.push('SSH 跳板机格式无效（期望 user@host）')
          else updates.OBMC_SSH_TARGET = value
        }
        for (const [field, key, label] of [
          ['sshPort', 'OBMC_SSH_PORT', 'SSH 端口'],
          ['relayPort', 'OBMC_RELAY_PORT', 'relay 端口'],
        ]) {
          if (body[field] !== undefined && body[field] !== '') {
            const value = String(body[field]).trim()
            if (!isValidPort(value)) errors.push(`${label}无效（1-65535）`)
            else updates[key] = value
          }
        }
        if (body.subnet !== undefined && body.subnet !== '') {
          const value = String(body.subnet).trim()
          if (!isValidSubnet(value)) errors.push('网段格式无效（期望 a.b.c）')
          else updates.OBMC_SUBNET = value
        }
        if (errors.length > 0) {
          writeJson(res, 400, { errors })
          return
        }
        const before = { bmcTarget: envConfig.bmcTarget, relayPort: envConfig.relayPort }
        if (Object.keys(updates).length > 0) updateEnvFile(updates)
        Object.assign(envConfig, readEnvConfig())
        bmcState.target = envConfig.bmcTarget
        // Only a change to a tunnel-affecting key warrants bouncing a
        // running relay; first-save or discovery-only edits do not.
        const tunnelChanged = before.bmcTarget !== envConfig.bmcTarget || before.relayPort !== envConfig.relayPort
        return relayActiveState().then(state => {
          const verified = tunnelChanged && state === 'active' ? relayRestart() : Promise.resolve(null)
          return verified.then(result => relayInfo().then(relay => writeJson(res, 200, {
            saved: true,
            config: publicConfig(),
            relay,
            verified: result,
          })))
        })
      }).catch(error => writeJson(res, 400, { errors: [error.message] }))
    }),
  }, 'dsh-obmc-web: /bmc-config')

  // One-click relay unit management: generate the unit from the current
  // validated config, daemon-reload, (re)start it and verify the tunnel.
  // If the configured relay port is taken by something else, shift to the
  // next free port and report the adjustment.
  register({
    kind: 'exact',
    path: '/bmc-relay-install',
    handler: guarded((req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false })
        return
      }
      ;(async () => {
        if (envConfig.bmcTarget === null || envConfig.sshTarget === null) {
          writeJson(res, 400, { errors: ['请先在部署配置里填写 BMC 地址与 SSH 跳板机并保存'] })
          return
        }
        let portAdjusted = null
        if (await portInUse(envConfig.relayPort) && await relayActiveState() !== 'active') {
          let found = null
          for (let candidate = envConfig.relayPort + 1; candidate <= envConfig.relayPort + 50; candidate += 1) {
            if (!(await portInUse(candidate))) { found = candidate; break }
          }
          if (found === null) {
            writeJson(res, 500, { errors: [`端口 ${envConfig.relayPort} 被占用，且其后 50 个端口均无空闲`] })
            return
          }
          updateEnvFile({ OBMC_RELAY_PORT: String(found) })
          Object.assign(envConfig, readEnvConfig())
          bmcState.target = envConfig.bmcTarget
          portAdjusted = found
        }
        try {
          fs.mkdirSync(path.dirname(unitPath()), { recursive: true })
          fs.writeFileSync(unitPath(), generateUnit(envConfig), { mode: 0o644 })
        } catch (error) {
          writeJson(res, 500, { errors: [`写入 unit 文件失败：${error.message}`] })
          return
        }
        try {
          await systemdManagerCall(['Reload'])
          const verified = await relayRestart()
          const relay = await relayInfo()
          writeJson(res, 200, { installed: true, relay, verified, portAdjusted })
        } catch (error) {
          writeJson(res, 500, { errors: [`systemd 操作失败：${error.message}`] })
        }
      })()
    }),
  }, 'dsh-obmc-web: /bmc-relay-install')

  // The iframe entry: GUI origin '/bmc…' → BMC '/…' ('' maps to '/').
  register({
    kind: 'prefix',
    path: '/bmc',
    handler: guarded((req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const rest = url.pathname.slice('/bmc'.length)
      const target = (rest === '' ? '/' : rest) + url.search
      proxyRequest(req, res, target, ctx.logger)
    }),
  }, 'dsh-obmc-web: /bmc entry prefix')

  // Root-absolute asset/API families the bmcweb SPA hardcodes.
  for (const path of ['/js', '/css', '/redfish']) {
    register({
      kind: 'prefix',
      path,
      handler: guarded((req, res) => proxyRequest(req, res, req.url ?? '/', ctx.logger)),
    }, `dsh-obmc-web: ${path} prefix`)
  }
  for (const path of ['/login', '/logout']) {
    register({
      kind: 'exact',
      path,
      handler: guarded((req, res) => proxyRequest(req, res, req.url ?? '/', ctx.logger)),
    }, `dsh-obmc-web: ${path} exact`)
  }

  // WebSocket endpoints (KVM / console) — exact-path upgrade tunnels.
  for (const path of ['/kvm', '/console']) {
    try {
      ctx.effect(() => ctx.webServer.registerUpgrade({
        path,
        handler: (req, socket, head) => {
          if (!fence(req)) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
            socket.destroy()
            return
          }
          proxyUpgrade(req, socket, head, ctx.logger)
        },
      }), `dsh-obmc-web: ${path} upgrade`)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-obmc-web] skipped ${path} upgrade: ${error.message}`)
    }
  }
}

/** Serialized live tunnel probe (dedupes concurrent client polls). */
let probeInFlight = null
let probeAt = 0
function awaitTunnelProbe() {
  if (probeInFlight !== null && Date.now() - probeAt < 4_000) return probeInFlight
  probeAt = Date.now()
  probeInFlight = tunnelRequest('/redfish/v1', 6_000).finally(() => {
    setTimeout(() => { probeInFlight = null }, 4_000)
  })
  return probeInFlight
}
