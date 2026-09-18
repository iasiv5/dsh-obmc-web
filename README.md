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

**推荐方式：全部在网页里完成。** 首次安装后打开「设置 → BMC 控制台」，
展开「部署配置」表单：

1. 填 **BMC 地址**（`ip` 或 `ip:port`，端口缺省 443）与 **SSH 跳板机**
   （`user@host`，可选；用于 IP 自动探测）、SSH 端口、链路网段（可空，
   默认取 BMC IP 的 /24）、relay 本地端口（默认 18443，被占用时才需要改）；
2. 点 **保存配置**——值经校验后写入共享 env 文件（原地更新对应行，注释
   与未知键保留）；影响隧道的键变化且 relay 在运行时会自动重启并验证；
3. 新机器上点 **安装并启动 relay 服务**——插件按当前配置生成
   `~/.config/systemd/user/obmc-web-relay.service`，daemon-reload 并启动，
   隧道验证通过后报告。之后升级配置也用同一个按钮。

**手动方式（高级）**：配置实际存储在插件与 relay unit 共用的
`KEY=VALUE` 文件 `~/.config/systemd/user/obmc-relay.env`（可用环境变量
`OBMC_WEB_ENV` 改位置）。首次启动若文件不存在，插件自动生成一份全注释
的模板（含说明与文档示例地址）；手改后重启 dsh web 生效。模板见
`deploy/relay.env.example`：

| 键 | 必填 | 说明 |
|---|---|---|
| `BMC_TARGET` | 是 | 当前 BMC 地址 `ip:port`，relay unit 的 ExecStart 消费；自动探测会原地改写此行（保留其他键） |
| `OBMC_SSH_TARGET` | 否 | 自动探测用的跳板机 SSH 目标 `user@host`（需已配好 BatchMode 免密）；不配则探测功能关闭，代理不受影响 |
| `OBMC_SSH_PORT` | 否 | 跳板机 SSH 端口，默认 22 |
| `OBMC_SUBNET` | 否 | 探测扫描的链路网段 `a.b.c`，缺省取 `BMC_TARGET` IP 的 /24 |
| `OBMC_RELAY_PORT` | 否 | relay 本地监听端口，默认 18443，需与 relay unit 的 `-L` 参数一致 |

代码本身不含任何站点相关默认值——你的网络拓扑只活在这份配置里（表单
和 env 文件是同一份数据的两个入口）。DSH 自身的 3080、公网反代端口等
属于 DSH/网关层，与本插件无关，无需在此配置。

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
