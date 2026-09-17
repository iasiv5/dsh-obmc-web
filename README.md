# @iasiv5/dsh-obmc-web

在 DSH 侧边栏里使用 **BMC Web UI**（OpenBMC / bmcweb，AST2700 EVB 实测）。
host 半身在 DSH web 服务器的 GUI origin 上注册一组同源代理路由，经
`obmc-web-relay.service`（SSH 本地转发，仅绑 `127.0.0.1:18443`）抵达 BMC；
client 半身仿照 dsh-surf，在「设置」菜单位注册一个 **BMC 控制台** 启动面板：
显示隧道状态芯片与当前 BMC 地址，一键在顶层标签页打开控制台，并支持
BMC IP 变化后的 SSH 自动探测与隧道重定向。

```
浏览器 ── GUI origin (/bmc, /js, /css, /redfish, /login, /logout, /kvm WS)
   └─ dsh web server (127.0.0.1:3080) ── @iasiv5/dsh-obmc-web host 路由
        │                                （剥 XFO/HSTS/WWW-Authenticate/frame-ancestors）
        └─ obmc-web-relay.service (ssh -N -L 127.0.0.1:18443 → $BMC_TARGET)
             └─ BMC (bmcweb, hash 路由 SPA)
```

## 为什么是这些路由

bmcweb 的 SPA 以根绝对路径引用资源与 API（`/js/…`、`/css/…`、`/redfish/…`、
`/login`、`/logout`；KVM/串口走 `/kvm` WebSocket），且路由为 hash 模式，因此
挂在 `/bmc` 前缀下不会与 SPA 内部导航冲突。DSH web 服务器按「精确表优先、
前缀最长者胜」分发，GUI 自身的路由永远优先；重复注册只跳过、不会让插件失败。

## 安装

```bash
# 在 DSH 安装目录执行（插件底层走 pnpm add，npm 包直接可用）
dsh plugin --profile web add @iasiv5/dsh-obmc-web
```

然后重启 dsh web。「设置」菜单里会出现 **BMC 控制台** 面板。

本地开发可用 link 方式：

```bash
dsh plugin --profile web add link:/path/to/dsh-obmc-web
```

## 配置

插件与 relay unit 共用一份 `KEY=VALUE` 配置文件
`~/.config/systemd/user/obmc-relay.env`（可用环境变量 `OBMC_WEB_ENV`
改位置；模板见 `deploy/relay.env.example`）：

| 键 | 必填 | 说明 |
|---|---|---|
| `BMC_TARGET` | 是 | 当前 BMC 地址 `ip:port`，relay unit 的 ExecStart 消费；自动探测会原地改写此行（保留其他键） |
| `OBMC_SSH_TARGET` | 否 | 自动探测用的跳板机 SSH 目标 `user@host`（需已配好 BatchMode 免密）；不配则探测功能关闭，代理不受影响 |
| `OBMC_SSH_PORT` | 否 | 跳板机 SSH 端口，默认 22 |
| `OBMC_SUBNET` | 否 | 探测扫描的链路网段 `a.b.c`，缺省取 `BMC_TARGET` IP 的 /24 |

代码本身不含任何站点相关默认值——你的网络拓扑只活在这份 env 文件里。
配置在 dsh web 启动时读取，改动后需重启。

relay unit 参考配置见 `deploy/obmc-web-relay.service.example`（安装到
`~/.config/systemd/user/obmc-web-relay.service`，`systemctl --user
enable --now obmc-web-relay.service`）。SSH 目标、端口、BMC 地址都在
unit 内或 env 文件里占位，按你的部署填写。

## BMC IP 自动探测

BMC 地址常由跳板侧 DHCP 动态分配，可能变化。当隧道目标失联（代理上游
报错，或 `/bmc-status?probe=1` 实测失败）时，插件自动 SSH 到跳板机定位
bmcweb 实际地址：先查 dnsmasq 租约表 + ARP 表（单纯换址时亚秒级返回），
不通再做全网段 TCP-443 扫描；候选地址以 `/redfish/v1` 应答做指纹校验。
找到后写回 env 文件的 `BMC_TARGET` 行、经 user manager 重启 relay，并
通过隧道验证后才报告成功。手动触发：面板「重新探测 IP」按钮（即
`POST /bmc-status`），自带 60s 冷却。

## 安全说明

- 上游仅 `127.0.0.1:18443`（SSH 隧道），不新增任何公网监听。
- 剥掉的响应头：`X-Frame-Options`、`Strict-Transport-Security`、
  `WWW-Authenticate`（防止 bmcweb 的 401 Basic challenge 弹浏览器原生
  凭据框；BMC SPA 走 POST /login JSON + cookie），CSP 仅移除
  `frame-ancestors` 指令；其余（含 Cookie）原样透传。
- 不在任何地方存储 BMC 凭据；登录在 BMC 自身页面完成。
- 信任围栏仿照 dsh-better-sidebar 的 trust-fence（Host 必须是 loopback
  或部署信任的 authority、`Sec-Fetch-Site` 不得为 cross-site、Origin 若有
  必须与 Host 同 hostname）——这是 DNS-rebinding 防御，不是认证；真正的
  访问控制由部署在 GUI 前面的既有网关承担。
- 已知取舍：iframe 内容与 GUI 同源（bmcweb 需要 Cookie 登录，无法用
  opaque-origin sandbox）。信任级别等同于在浏览器同站打开 BMC 页面。

## License

[MIT](./LICENSE)
