// dsh-obmc-web client half.
//
// Single surface: a first-level「BMC 控制台」entry in the Settings menu
// (the `settings.section` slot, the same mechanism dsh-surf uses for
// 「网络冲浪」).
//
// The auth edge (dsh-auth-caddy) stamps X-Frame-Options DENY on every
// response, so the BMC UI cannot render inside a sidebar iframe through the
// public entries. The entry is therefore a launcher panel: it polls the
// same-origin /bmc-status route (fetch is unaffected by XFO; ?probe=1 asks
// the host for a live tunnel verdict) and opens the console with
// window.open — a TOP-LEVEL navigation, where X-Frame-Options does not
// apply. When the DHCP-assigned BMC address changes, the host discovers it
// over SSH and retargets the tunnel; the panel shows the current target
// and the latest discovery outcome.
//
// The package registration id MUST equal package.json `name`.
window.__ModuleLoader__.load({
  id: '@iasiv5/dsh-obmc-web',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const SECTION_ID = 'dsh-obmc-web'
    const ENTRY_URL = '/bmc'
    const STATUS_URL = '/bmc-status'

    function openBmcConsole() {
      window.open(ENTRY_URL, '_blank', 'noopener,noreferrer')
    }

    function formatTime(epochMs) {
      if (!epochMs) return ''
      try {
        return new Date(epochMs).toLocaleTimeString()
      } catch {
        return ''
      }
    }

    const CHIP = {
      online: { color: '#34d399', label: '隧道在线 · AST2700 EVB BMC' },
      discovering: { color: '#60a5fa', label: '正在 SSH 探测 BMC 新 IP…' },
      auth: { color: '#fbbf24', label: 'DSH 会话已过期，请重新登录后重试' },
      degraded: { color: '#fbbf24', label: '可达但响应异常' },
      offline: { color: '#f87171', label: 'BMC 不可达（探测/切换中或 relay 未运行）' },
      probing: { color: '#9ca3af', label: '探测中…' },
    }

    // Polls /bmc-status every 15s (2s while a discovery round is running).
    // ?probe=1 makes the host verify the tunnel live; the returned `ok`
    // field is the authoritative tunnel verdict for the chip.
    function useBmcStatus() {
      const [status, setStatus] = React.useState(null)
      const statusRef = React.useRef(null)
      React.useEffect(() => {
        let cancelled = false
        let timer = null
        const poll = async () => {
          let next = { __chip: 'offline' }
          try {
            const response = await fetch(`${STATUS_URL}?probe=1`, { cache: 'no-store' })
            if (response.redirected && String(response.url).includes('/auth/login')) {
              next = { __chip: 'auth' }
            } else if (!response.ok) {
              next = { __chip: 'degraded' }
            } else {
              const data = await response.json()
              if (data.discovering) next = { ...data, __chip: 'discovering' }
              else if (data.ok === true) next = { ...data, __chip: 'online' }
              else if (data.ok === false) next = { ...data, __chip: 'offline' }
              else next = { ...data, __chip: 'probing' }
            }
          } catch {
            next = { __chip: 'offline' }
          }
          if (cancelled) return
          statusRef.current = next
          setStatus(next)
          timer = setTimeout(poll, next.discovering ? 2_000 : 15_000)
        }
        poll()
        return () => {
          cancelled = true
          if (timer) clearTimeout(timer)
        }
      }, [])
      return status
    }

    function StatusChip() {
      const status = useBmcStatus()
      const chip = CHIP[status === null ? 'probing' : status.__chip] || CHIP.probing
      return React.createElement(
        'span',
        {
          style: {
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            fontSize: '12px', padding: '3px 10px', borderRadius: '999px',
            border: '1px solid rgba(128,128,128,.4)',
          },
        },
        React.createElement('span', {
          style: {
            width: '8px', height: '8px', borderRadius: '50%',
            background: chip.color, boxShadow: `0 0 6px ${chip.color}`, flex: 'none',
          },
        }),
        chip.label,
      )
    }

    function TargetLine() {
      const status = useBmcStatus()
      const discovery = status && status.lastDiscovery
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        React.createElement(
          'div',
          { style: { fontSize: '12.5px', fontFamily: 'ui-monospace,Consolas,monospace' } },
          '当前 BMC IP：',
          React.createElement('strong', null, (status && status.target) || '未知'),
        ),
        discovery && discovery.verified
          ? React.createElement(
            'div',
            { style: { fontSize: '11.5px', opacity: 0.75 } },
            `最近探测：${discovery.found}（${formatTime(discovery.at)}，隧道已切换并验证）`,
          )
          : null,
      )
    }

    function RedetectButton() {
      const status = useBmcStatus()
      const [busy, setBusy] = React.useState(false)
      const trigger = () => {
        setBusy(true)
        fetch(STATUS_URL, { method: 'POST', cache: 'no-store' })
          .catch(() => {})
          .finally(() => setTimeout(() => setBusy(false), 1_500))
      }
      const unconfigured = status !== null && status.discoveryConfigured === false
      const disabled = busy || (status !== null && status.discovering === true) || unconfigured
      return React.createElement(
        'button',
        {
          type: 'button',
          onClick: trigger,
          disabled,
          title: unconfigured
            ? '未配置自动探测：在 relay env 文件里设置 OBMC_SSH_TARGET 后重启 dsh web'
            : 'BMC IP 变化后手动触发：SSH 登录跳板机查找 bmcweb 实际地址并切换隧道',
          style: {
            fontSize: '12px', padding: '6px 14px', borderRadius: '8px',
            cursor: disabled ? 'default' : 'pointer',
            border: '1px solid rgba(128,128,128,.45)', background: 'transparent',
            color: 'inherit', opacity: disabled ? 0.55 : 1,
          },
        },
        disabled ? '探测中…' : '重新探测 IP',
      )
    }

    function OpenButton() {
      return React.createElement(
        'button',
        {
          type: 'button',
          onClick: openBmcConsole,
          style: {
            fontSize: '14px', padding: '10px 22px', borderRadius: '10px',
            cursor: 'pointer', border: '1px solid rgba(59,130,246,.55)',
            background: 'rgba(59,130,246,.16)', color: 'inherit',
          },
        },
        '🖥 打开 BMC Web 控制台',
      )
    }

    const HINT = '新标签页顶层打开（同源代理 /bmc → SSH 隧道 → BMC）。若 BMC 的 IP 由 DHCP 动态分配，变化失联时会自动 SSH 到跳板机探测新地址并切换隧道，也可点「重新探测 IP」手动触发。登录凭据在 BMC 页面内输入，不会存储。'

    // Settings →「BMC 控制台」: mirrors dsh-surf's settings.section pattern.
    function BmcSettingsSection() {
      return React.createElement(
        'section',
        {
          'data-obmc-web': 'settings-section',
          style: {
            display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            borderRadius: '12px',
          },
        },
        React.createElement('strong', null, 'BMC 控制台'),
        React.createElement(StatusChip),
        React.createElement(TargetLine),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } },
          React.createElement(OpenButton),
          React.createElement(RedetectButton),
        ),
        React.createElement(
          'p',
          { style: { margin: 0, color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px', lineHeight: 1.6 } },
          HINT,
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.slots
      if (slots && typeof slots.inject === 'function') {
        ctx.slots.inject('settings.section', () => slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: 131,
            label: 'BMC 控制台',
          },
          BmcSettingsSection,
        ))
      }
    }

    exports.name = 'dsh-obmc-web/client'
    exports.inject = ['slots']
    exports.apply = apply
    exports.BmcSettingsSection = BmcSettingsSection
    exports.openBmcConsole = openBmcConsole
    return module.exports
  },
})
