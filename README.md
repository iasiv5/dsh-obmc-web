# @iasiv5/dsh-obmc-web

在 DSH GUI 里使用 **BMC Web UI**（OpenBMC / bmcweb，AST2700 EVB 实测）。
host 半身在 DSH web 服务器的 GUI origin 上注册一组同源代理路由，经
`obmc-web-relay.service`（SSH 本地转发，仅绑 `127.0.0.1`，端口默认
18443、被占自动顺延）抵达 BMC；client 半身仿照 dsh-surf，在「设置」
菜单位注册一个 **BMC 控制台** 启动面板：显示隧道状态芯片与当前 BMC
地址，一键在顶层标签页打开控制台，并支持 BMC IP 变化后的 SSH 自动
探测与隧道重定向。

> 控制台不放进侧边栏 iframe：公网入口的 dsh-auth-caddy 给所有响应盖了
> `X-Frame-Options: DENY`，因此面板用 `window.open` 做**顶层导航**（XFO
> 不约束顶层页面）。登录仍在 BMC 自己的页面里完成，本插件不经手凭据。

```
浏览器 ── GUI origin (/bmc, /js, /css, /redfish, /login, /logout, /kvm·/console WS)
   └─ dsh web server (127.0.0.1:3080) ── @iasiv5/dsh-obmc-web host 路由
        │                                （剥 XFO/HSTS/WWW-Authenticate/frame-ancestors）
        └─ obmc-web-relay.service (ssh -N -L 127.0.0.1:<relay端口> → $BMC_TARGET)
             └─ BMC (bmcweb, hash 路由 SPA)
```

## 面板一览

「设置 → BMC 控制台」从上到下：

- **状态芯片**：整个面板共享一次轮询，每 15s 打一次 `/bmc-status?probe=1`
  （探测轮进行中改为 2s），实测隧道后显示：隧道在线 / 正在 SSH 探测 /
  DSH 会话已过期 / 可达但响应异常 / BMC 不可达；保存配置、探测 IP、
  安装 relay 这类影响隧道的动作完成后会**立即重新探测**，芯片在 1~2s 内
  跟上动作结果，不必等下一个轮询周期；
- **当前 BMC IP** 与最近一次探测结果（找到的地址、时间、是否已切换并验证）；
- **部署配置表单**：五个等宽输入框（SSH 跳板机、SSH 端口、BMC 地址、
  网段、relay 本地端口），加 保存配置 / 探测 BMC IP / 安装并启动 relay
  服务 三个动作与 relay 运行状态一行；
- **打开 BMC Web 控制台**：顶层标签页打开；尚未配置 BMC 地址时置灰。

## 为什么是这些路由

bmcweb 的 SPA 以根绝对路径引用资源与 API（`/js/…`、`/css/…`、`/redfish/…`、
`/login`、`/logout`；KVM/串口走 `/kvm`、`/console` WebSocket），且路由为
hash 模式，因此挂在 `/bmc` 前缀下不会与 SPA 内部导航冲突。DSH web 服务器
按「精确表优先、前缀最长者胜」分发，GUI 自身的路由永远优先；重复注册只
跳过、不会让插件失败。

## 安装

```bash
# 任意目录执行即可（dsh plugin 把参数转发给 profile 目录里的 pnpm）
dsh plugin --profile web add @iasiv5/dsh-obmc-web
```

然后重启 dsh web。「设置」菜单里会出现 **BMC 控制台** 面板。

本地开发可用 link 方式直装源码：

```bash
dsh plugin --profile web add link:/path/to/dsh-obmc-web
```

## 配置

**推荐方式：全部在网页里完成。** 首次安装后打开「设置 → BMC 控制台」，
展开「部署配置」表单：

1. 填 **SSH 跳板机**（`user@host`；与 BMC 链路网段相通、已配好对本机
   BatchMode 免密登录的机器）与 SSH 端口；**BMC 地址可以留空**；
   链路网段、relay 本地端口（默认 18443）均可留空用默认；
2. 点 **「探测 BMC IP」**——先保存表单，再 SSH 登录跳板机自动发现
   bmcweb 地址并回填；BMC IP 被 DHCP 改变后，也用同一个按钮（此时显示
   「重新探测 IP」）重新找回并切换隧道；同一时刻只有一轮探测在跑；
3. 点 **「安装并启动 relay 服务」**——插件按当前配置生成
   `~/.config/systemd/user/obmc-web-relay.service`，daemon-reload 并启动，
   隧道验证通过后报告；若配置的 relay 端口被其他程序占用，会自动顺延到
   空闲端口并提示。之后升级配置也用同一个按钮。

**保存配置**单独说明：表单立即写入 env 文件并生效；若 BMC 地址或 relay
端口发生变化且 relay 正在运行，会自动重启 relay 并验证隧道，结果随保存
响应返回（首次保存、只改跳板机等不影响隧道的编辑不会重启 relay）。

**手动方式（高级）**：配置实际存储在插件与 relay unit 共用的
`KEY=VALUE` 文件 `~/.config/systemd/user/obmc-relay.env`（可用环境变量
`OBMC_WEB_ENV` 改位置）。首次启动若文件不存在，插件自动生成一份全注释
的模板（含说明与文档示例地址）；手改后重启 dsh web 生效。模板见
`deploy/relay.env.example`；手工安装用的 unit 示例在
`deploy/obmc-web-relay.service.example`（一般用不着——面板按钮会生成）：

| 键 | 必填 | 说明 |
|---|---|---|
| `BMC_TARGET` | 是* | 当前 BMC 地址 `ip:port`，relay unit 的 ExecStart 消费；自动探测会原地改写此行（保留其他键）。表单保存与探测都会补全成 `ip:443`——**手写时请务必带端口**，`ssh -L` 的转发目标需要 `host:port` 形式。*可用「探测 BMC IP」自动发现 |
| `OBMC_SSH_TARGET` | 探测必填 | 跳板机 SSH 目标 `user@host`（BatchMode 免密）；不配则探测关闭，代理不受影响 |
| `OBMC_SSH_PORT` | 否 | 跳板机 SSH 端口，默认 22 |
| `OBMC_SUBNET` | 否 | 探测网段 `a.b.c`；缺省先取 `BMC_TARGET` IP 的 /24，连 BMC IP 都没有时，探测会在跳板机上自动枚举直连 IPv4 网段逐个扫 |
| `OBMC_RELAY_PORT` | 否 | relay 本地监听端口，默认 18443，需与 relay unit 的 `-L` 参数一致（面板的安装按钮会保持两者同步） |

代码本身不含任何站点相关默认值——你的网络拓扑只活在这份配置里（表单
和 env 文件是同一份数据的两个入口）。真正必须由人类提供的只有跳板机
这一项；DSH 自身的 3080、公网反代端口等属于 DSH/网关层，与本插件无关，
无需在此配置。

## BMC IP 自动探测

BMC 地址常由跳板侧 DHCP 动态分配，可能变化。当隧道目标失联（代理上游
报错，或 `/bmc-status?probe=1` 实测失败）时，插件自动 SSH 到跳板机定位
bmcweb 实际地址：先查 dnsmasq 租约表 + ARP 表（单纯换址时亚秒级返回），
不通再对候选网段做 TCP-443 扫描；候选地址以 `/redfish/v1` 应答做指纹
校验（200 或 401 都算 bmcweb 在场）。探测网段的确定顺序：配置的
`OBMC_SUBNET` → `BMC_TARGET` IP 的 /24 → 跳板机自身枚举的直连 IPv4
网段。找到后写回 env 文件的 `BMC_TARGET` 行、经 user manager 重启
relay，并通过隧道验证后才报告成功；若 relay unit 尚未安装（首次
bootstrap），地址仍会写入配置并提示下一步去点「安装并启动 relay
服务」。SSH 层失败（地址/端口/免密）会透出真实原因，不会伪装成
「未发现 bmcweb」。触发方式：

- 手动：部署配置里的「探测 BMC IP / 重新探测 IP」按钮（`POST
  /bmc-status`），不设冷却，但同一时刻仅一轮；
- 自动：代理上游报错时触发，自带 60s 冷却。

## 安全说明

- 上游仅 `127.0.0.1`（SSH 隧道，端口默认 18443），不新增任何公网监听。
- 剥掉的响应头：`X-Frame-Options`、`Strict-Transport-Security`、
  `WWW-Authenticate`（防止 bmcweb 的 401 Basic challenge 弹浏览器原生
  凭据框；BMC SPA 走 POST /login JSON + cookie），CSP 仅移除
  `frame-ancestors` 指令；其余（含 Cookie）原样透传。
- 非 `/login` 的上游 401 统一降级为 403：BMC SPA 的 axios 拦截器对其他
  401 会执行 `window.location = "/login"`——根绝对路径的顶层导航，在
  同源代理下会逃出 `/bmc` 前缀，落到 GUI 自己的 `/login` 并被认证门
  重定向进 DSH 应用，把用户从 BMC 控制台拽走（首次打开最常见）。403
  走 SPA 的原地「未授权」提示，不发生导航；`/login` 的真实 401 保留
  （登录表单错误处理与 CSRF 探测依赖它）。
- 不在任何地方存储 BMC 凭据；登录在 BMC 自身页面完成。
- 信任围栏仿照 dsh-better-sidebar 的 trust-fence（Host 必须是 loopback
  或部署信任的 authority、`Sec-Fetch-Site` 不得为 cross-site、Origin 若有
  必须与 Host 同 hostname）——这是 DNS-rebinding 防御，不是认证；真正的
  访问控制由部署在 GUI 前面的既有网关承担。
- 已知取舍：代理内容与 GUI 同源（bmcweb 需要 Cookie 登录，无法用
  opaque-origin sandbox）。信任级别等同于在浏览器同站打开 BMC 页面。

## License

[MIT](./LICENSE)
