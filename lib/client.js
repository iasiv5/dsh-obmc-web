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
    const CONFIG_URL = '/bmc-config'
    const RELAY_INSTALL_URL = '/bmc-relay-install'

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
      online: { color: '#34d399', label: '隧道在线 · BMC' },
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

    function OpenButton() {
      const status = useBmcStatus()
      const unconfigured = status !== null && !status.target
      return React.createElement(
        'button',
        {
          type: 'button',
          onClick: openBmcConsole,
          disabled: unconfigured,
          title: unconfigured ? '尚未配置 BMC 地址：先在下方部署配置里探测或填写' : undefined,
          style: {
            fontSize: '14px', padding: '10px 22px', borderRadius: '10px',
            cursor: unconfigured ? 'default' : 'pointer', border: '1px solid rgba(59,130,246,.55)',
            background: 'rgba(59,130,246,.16)', color: 'inherit', opacity: unconfigured ? 0.5 : 1,
          },
        },
        '🖥 打开 BMC Web 控制台',
      )
    }

    const HINT = '新标签页顶层打开（同源代理 /bmc → SSH 隧道 → BMC）。若 BMC 的 IP 由 DHCP 动态分配，变化失联时会自动 SSH 到跳板机探测新地址并切换隧道，也可点「重新探测 IP」手动触发。登录凭据在 BMC 页面内输入，不会存储。'

    const inputStyle = {
      fontSize: '13px', padding: '6px 10px', borderRadius: '8px',
      border: '1px solid rgba(128,128,128,.45)', background: 'transparent', color: 'inherit',
    }

    // Deployment form: reads/writes the shared env file through
    // GET/POST /bmc-config; one-click relay unit install via
    // POST /bmc-relay-install. Fresh machines need nothing but this form.
    function DeployConfigForm() {
      const [envFile, setEnvFile] = React.useState('')
      const [relay, setRelay] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(CONFIG_URL, { cache: 'no-store' })
          if (!response.ok) return
          const data = await response.json()
          setEnvFile(data.envFile || '')
          setRelay(data.relay || null)
          setForm({
            bmcTarget: (data.config && data.config.bmcTarget) || '',
            sshTarget: (data.config && data.config.sshTarget) || '',
            sshPort: String((data.config && data.config.sshPort) ?? 22),
            subnet: (data.config && data.config.subnet) || '',
            relayPort: String((data.config && data.config.relayPort) ?? 18443),
          })
        } catch { /* panel still renders; the host may be older */ }
      }, [])
      React.useEffect(() => { load() }, [load])

      if (form === null) {
        return React.createElement('div', { style: { fontSize: '12px', opacity: 0.7 } }, '部署配置加载中…')
      }

      const field = (label, key, placeholder, flex) => React.createElement(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', flex: flex || '1 1 220px' } },
        label,
        React.createElement('input', {
          value: form[key],
          placeholder,
          onChange: e => setForm({ ...form, [key]: e.target.value }),
          style: inputStyle,
        }),
      )

      const saveForm = async () => {
        const response = await fetch(CONFIG_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(form),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) return { ok: false, text: (data.errors || [data.error || '保存失败']).join('；') }
        return { ok: true, data }
      }

      const save = async () => {
        setBusy(true)
        setMsg(null)
        try {
          const result = await saveForm()
          if (!result.ok) {
            setMsg({ ok: false, text: result.text })
            return
          }
          const { data } = result
          setMsg({
            ok: data.verified !== false,
            text: data.verified === true
              ? '已保存，隧道验证通过'
              : data.verified === false
                ? '已保存，但隧道验证未通过（检查跳板机免密登录与 BMC 地址）'
                : '已保存',
          })
          await load()
        } catch (error) {
          setMsg({ ok: false, text: '保存失败：' + error.message })
        } finally {
          setBusy(false)
        }
      }

      // Explicit discovery action: persist the form first (probe runs on the
      // saved values), then start an SSH discovery round and wait it out.
      // Fills the BMC address field when bootstrap-finding, or re-finds a
      // moved BMC and retargets the tunnel.
      const probe = async () => {
        setBusy(true)
        setMsg(null)
        try {
          const saved = await saveForm()
          if (!saved.ok) {
            setMsg({ ok: false, text: saved.text })
            return
          }
          await fetch(STATUS_URL, { method: 'POST', cache: 'no-store' })
          setMsg({ ok: true, text: '正在探测：SSH 登录跳板机查找 bmcweb（通常几秒到一分钟）…' })
          let seenBusy = false
          let status = null
          for (let i = 0; i < 40; i++) {
            await new Promise(resolve => setTimeout(resolve, 2_000))
            status = await fetch(STATUS_URL, { cache: 'no-store' }).then(r => r.json()).catch(() => null)
            if (status && status.discovering === true) seenBusy = true
            if ((seenBusy && status && status.discovering === false) || (!seenBusy && i >= 5)) break
          }
          const cfg = await fetch(CONFIG_URL, { cache: 'no-store' }).then(r => r.json()).catch(() => null)
          const found = cfg && cfg.config && cfg.config.bmcTarget
          const relayInstalled = cfg && cfg.relay && cfg.relay.installed
          if (found) {
            setMsg({
              ok: true,
              text: `探测成功：BMC 地址 ${found}${relayInstalled ? '，隧道已就绪' : '，接下来点「安装并启动 relay 服务」打通隧道'}`,
            })
          } else {
            setMsg({ ok: false, text: (status && status.lastError) || '未发现 bmcweb：请检查跳板机免密登录、网段或 BMC 是否在线' })
          }
          await load()
        } catch (error) {
          setMsg({ ok: false, text: '探测失败：' + error.message })
        } finally {
          setBusy(false)
        }
      }

      const installRelay = async () => {
        setBusy(true)
        setMsg(null)
        try {
          const response = await fetch(RELAY_INSTALL_URL, { method: 'POST' })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) {
            setMsg({ ok: false, text: (data.errors || [data.error || '安装失败']).join('；') })
          } else {
            const adjusted = data.portAdjusted ? `；原端口被占用，已自动改用 ${data.portAdjusted}` : ''
            setMsg({
              ok: data.verified !== false,
              text: data.verified === true
                ? `relay 服务已安装并启动，隧道验证通过${adjusted}`
                : `relay 服务已写入，但隧道验证未通过（查看 systemctl --user status obmc-web-relay）${adjusted}`,
            })
            await load()
          }
        } catch (error) {
          setMsg({ ok: false, text: '安装失败：' + error.message })
        } finally {
          setBusy(false)
        }
      }

      const button = (label, onClick, disabled, primary, title) => React.createElement(
        'button',
        {
          type: 'button',
          onClick,
          disabled: disabled || busy,
          title,
          style: {
            fontSize: '12px', padding: '6px 14px', borderRadius: '8px',
            cursor: disabled || busy ? 'default' : 'pointer',
            border: primary ? '1px solid rgba(59,130,246,.55)' : '1px solid rgba(128,128,128,.45)',
            background: primary ? 'rgba(59,130,246,.16)' : 'transparent',
            color: 'inherit', opacity: disabled || busy ? 0.55 : 1,
          },
        },
        busy ? '处理中…' : label,
      )

      const probeDisabled = !String(form.sshTarget || '').trim()
      const probeTitle = probeDisabled
        ? '先填写 SSH 跳板机（探测需要 SSH 登录它）'
        : form.bmcTarget
          ? 'BMC IP 变化后重新查找并自动切换隧道'
          : '用跳板机自动发现 BMC 地址并回填'
      const probeLabel = form.bmcTarget ? '重新探测 IP' : '探测 BMC IP'

      return React.createElement(
        'details',
        { style: { border: '1px solid rgba(128,128,128,.3)', borderRadius: '10px', padding: '10px 12px' } },
        React.createElement('summary', { style: { cursor: 'pointer', fontSize: '13px' } }, '部署配置（BMC 地址 / SSH 跳板机 / 端口）'),
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '10px' } },
          React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } },
            field('BMC 地址（ip 或 ip:port）', 'bmcTarget', '192.0.2.10 或 192.0.2.10:443'),
            field('SSH 跳板机（user@host，可选）', 'sshTarget', 'user@your-jump-host'),
          ),
          React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } },
            field('SSH 端口', 'sshPort', '22', '0 1 110px'),
            field('链路网段（可选，a.b.c）', 'subnet', '默认取 BMC IP 的 /24'),
            field('relay 本地端口', 'relayPort', '18443', '0 1 130px'),
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            button('保存配置', save, false, true),
            button(probeLabel, probe, probeDisabled, false, probeTitle),
            button(relay && relay.installed ? '重装/更新 relay 服务' : '安装并启动 relay 服务', installRelay, false, false),
            relay && React.createElement('span', { style: { fontSize: '11.5px', opacity: 0.75 } },
              `relay 服务：${relay.installed ? '已安装' : '未安装'} · 状态 ${relay.active}`),
          ),
          msg && React.createElement(
            'div',
            { style: { fontSize: '12px', color: msg.ok ? 'inherit' : '#f87171', lineHeight: 1.5 } },
            msg.text,
          ),
          React.createElement('div', { style: { fontSize: '11.5px', opacity: 0.65, lineHeight: 1.5 } },
            '配置存储于 ', React.createElement('code', null, envFile || '（host 未上报）'),
            '，也可手动编辑（改完重启 dsh web 生效）。跳板机需已配置对本机的 SSH 免密登录。',
          ),
        ),
      )
    }

    // Settings →「BMC 控制台」: mirrors dsh-surf's settings.section pattern.
    function BmcSettingsSection() {
      const status = useBmcStatus()
      const unconfigured = status !== null && !status.target
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
        unconfigured
          ? React.createElement(
            'div',
            {
              'data-obmc-web': 'unconfigured-notice',
              style: {
                fontSize: '12.5px', lineHeight: 1.6, padding: '10px 12px', borderRadius: '8px',
                border: '1px solid rgba(251,191,36,.5)', color: 'var(--dsw-alias-label-secondary, inherit)',
              },
            },
            '尚未配置 BMC 地址：展开下方「部署配置」，填好 SSH 跳板机后点「探测 BMC IP」即可自动发现地址，然后安装 relay 服务。',
          )
          : null,
        React.createElement(DeployConfigForm),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } },
          React.createElement(OpenButton),
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
