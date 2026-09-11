# MAARemote 部署指南（DEPLOY）

> **⚠️ 域名占位说明**：本文全文使用占位域名 **`maa.example.com`**。你确定监控子域名后（如 `maa.你的域名.com`），请把文中所有 `maa.example.com` **全局替换**为真实域名，`deploy\cloudflared-config.yml` 同理。其余命令（路径、端口、脚本名）与仓库现状一致，可直接照做。

## 0. 架构一览

```
[MAA 桌面端] --HTTP 轮询(出站)--> [MAARemote 服务端 127.0.0.1:24325]
                                        ▲ 127.0.0.1 回源（仅本机）
[cloudflared 隧道] --出站连接--> Cloudflare 边缘 <--HTTPS-- [浏览器]
                                        https://maa.example.com
```

- 服务端**只监听 127.0.0.1**（`server/src/index.js` 硬编码），端口读 `server/config.json` 的 `port`（默认 **24325**）。
- 全程无需公网 IP、无需路由器端口映射、**无需任何防火墙入站规则**（见 §7）。

## 1. 前置要求

| 组件 | 要求 | 检查 / 安装 |
|---|---|---|
| Node.js | ≥18 | `node --version`；未装：`winget install OpenJS.NodeJS.LTS` |
| PowerShell | 7（pwsh） | `pwsh --version`；未装：`winget install Microsoft.PowerShell` |
| cloudflared | 最新版 | `cloudflared --version`；未装：`winget install Cloudflare.cloudflared`（装完重开终端生效） |
| 域名 | NS 已托管 Cloudflare | 你的域名已完成（现状满足） |
| MAA 桌面端 | 已能正常连模拟器跑任务 | 与本服务零耦合，先后无所谓 |

以下命令均在 **pwsh 7** 中执行，工作目录假设为仓库根目录 `E:\AI-Workspace\MAARemote`（若你把仓库放到别处，替换对应路径）。

## 2. 启动服务端

```powershell
# 一键启动（自动：定位 server\ → npm install（幂等）→ 端口占用检测 → 前台启动）
pwsh -NoProfile -File start.ps1
```

- **首次启动**会自动生成 `server\config.json`（含两个**随机**令牌）与 `server\data\maa.db`。查看令牌：

  ```powershell
  Get-Content server\config.json
  # maaUserToken  → 填到 MAA「用户标识符」（§4）
  # dashboardToken→ 仪表盘 API 鉴权（§5）
  ```

- **验证服务在线**（无 token 访问仪表盘 API，返回 **401** 即正常，说明服务活着且鉴权生效）：

  ```powershell
  curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:24325/api/overview   # 输出 401
  ```

- 端口被占用时脚本会打印占用进程的 PID/进程名并退出，不会重复启动；若确认是本服务在跑，直接访问即可（脚本会探测 `/api/overview` 返回 401 自动识别并提示）。
- 停止：前台运行，**Ctrl+C** 即优雅退出（服务端自带 SIGINT/SIGTERM/SIGBREAK 处理）。
- 换端口：编辑 `server\config.json` 的 `port` 后重启（`deploy\cloudflared-config.yml` 里的端口要同步改）。

## 3. Cloudflare Tunnel（公网接入主线）

### 3.1 登录授权（浏览器一次）

```powershell
cloudflared tunnel login
```

浏览器弹出 Cloudflare 授权页 → 选择你的域名 → 授权。成功后本机 `%USERPROFILE%\.cloudflared\` 下生成证书 `cert.pem`。

### 3.2 创建隧道

```powershell
cloudflared tunnel create maa-remote
```

输出形如 `Created tunnel maa-remote with id <TUNNEL_ID>`，**记下这个 UUID**；同时凭据文件生成在：

```
%USERPROFILE%\.cloudflared\<TUNNEL_ID>.json      ← 凭据 json（勿外传、勿入库）
```

### 3.3 绑定域名（自动创建 CNAME）

```powershell
cloudflared tunnel route dns maa-remote maa.example.com
```

（把 `maa.example.com` 换成你确定的子域名；重复执行可改绑。）

### 3.4 放置配置文件

把仓库内示例复制为 cloudflared 默认配置，并替换占位符：

```powershell
Copy-Item deploy\cloudflared-config.yml $HOME\.cloudflared\config.yml
notepad $HOME\.cloudflared\config.yml
# 替换：<TUNNEL_ID> → 3.2 得到的 UUID
#       <CREDENTIALS_JSON_PATH> → %USERPROFILE%\.cloudflared\<TUNNEL_ID>.json（写完整绝对路径）
#       maa.example.com → 你的真实子域名
```

推荐路径即 `%USERPROFILE%\.cloudflared\config.yml`（前台试跑的默认读取位置）。

### 3.5 前台试跑（先开一个终端跑着 §2 的服务端，再开一个终端）

```powershell
cloudflared tunnel run maa-remote
```

浏览器/手机访问 `https://maa.example.com/api/overview` 返回 **401**（JSON `{"error":"unauthorized"}`）即全链路通。

### 3.6 注册 Windows 服务常驻（隧道侧）

```powershell
# 管理员 pwsh 中执行
cloudflared service install
```

**重要（Windows 特有坑）**：服务以 **LocalSystem** 身份运行，cloudflared 会改读

```
C:\Windows\System32\config\systemprofile\.cloudflared\config.yml
```

因此需把 `config.yml` **和凭据 json** 一并复制过去（管理员 pwsh）：

```powershell
New-Item -ItemType Directory -Force -Path "$env:SystemRoot\System32\config\systemprofile\.cloudflared" | Out-Null
Copy-Item $HOME\.cloudflared\config.yml                                $env:SystemRoot\System32\config\systemprofile\.cloudflared\
Copy-Item $HOME\.cloudflared\<TUNNEL_ID>.json                          $env:SystemRoot\System32\config\systemprofile\.cloudflared\
if ((Get-Service cloudflared).Status -ne 'Running') { Start-Service cloudflared }
```

装完即开机自启、断线自动重连。常用命令：`Get-Service cloudflared`（状态）、`cloudflared service uninstall`（卸载）。

## 4. MAA 端配置（远程控制）

1. MAA → **设置 → 远程控制**，填两项：
   - 获取任务端点：`https://maa.example.com/maa/getTask`
   - 汇报任务端点：`https://maa.example.com/maa/reportStatus`
   - **用户标识符**：填 `server\config.json` 的 **`maaUserToken`**（长随机串，当共享密钥用）。
2. 复制 MAA 界面显示的**设备标识符**（备用）。
3. 首次连接：MAA 会一直拿不到任务（服务端返回 401 待批准）——这是**安全设计**：去仪表盘「待批准设备」列表（`GET /api/devices/pending`）里**批准**该设备，批准前**复制 MAA 界面的设备标识符与列表核对**，确认是自己的 MAA 再批。批准后 MAA 立即开始正常取任务，无需重启。
4. （可选提速）汇报端点可改填 `http://127.0.0.1:24325/maa/reportStatus`——截图 Base64 不出公网、更快更省流量；代价是 MAA 每次回报记一条明文 HTTP 告警日志（仅日志噪音）。两项端点是分开填的，可独立组合。

## 5. 仪表盘访问

- 浏览器打开 `https://maa.example.com`（HTTPS 由 Cloudflare 自动终结，无需自管证书）。
- 仪表盘 API 均需 `dashboardToken` 鉴权（Bearer 头或 `?token=`；具体交互由前端实现）。
- 部署后自检：`https://maa.example.com/api/overview` 无 token → 401（公网可达 + 鉴权生效）；带 token → 200。

## 6. 常驻方案（服务端侧：NSSM）

§3.6 已解决 **cloudflared/tunnel** 的常驻；MAARemote 服务端本身（`node src\index.js`）建议用 **NSSM** 注册为 Windows 服务，实现开机自启、崩溃自动拉起：

1. 下载 NSSM：<https://nssm.cc/release/nssm-2.24.zip>，解压后取 `win64\nssm.exe` 放到一个**仓库外**的固定目录（如 `C:\Tools\nssm\`，避免二进制混入仓库），并在 PATH 中或用完整路径调用。
2. 管理员 pwsh 注册（`$node = (Get-Command node).Source` 先查 node 实际路径）：

   ```powershell
   nssm install MAARemote "$node" "src\index.js"
   nssm set MAARemote AppDirectory "E:\AI-Workspace\MAARemote\server"
   nssm set MAARemote AppStdout     "E:\AI-Workspace\MAARemote\logs\service-out.log"
   nssm set MAARemote AppStderr     "E:\AI-Workspace\MAARemote\logs\service-err.log"
   nssm set MAARemote AppStdoutCreationDisposition 4   # 追加写
   nssm set MAARemote AppStderrCreationDisposition 4
   nssm start MAARemote
   ```

   （`logs\` 已被 .gitignore 排除；用 NSSM 常驻后，日常不再需要 `start.ps1`，它是前台运行/调试用的。）
3. 管理：`Get-Service MAARemote`、`nssm restart MAARemote`、`nssm remove MAARemote confirm`（卸载）。

**电源计划（必做）**：睡眠会同时停掉 MAA、模拟器、服务端。系统设置 → 电源 → 屏幕和睡眠 →「接通电源时休眠」设为**从不**（屏幕可正常关闭）。命令行一键设置：`powercfg /change standby-timeout-ac 0`。

## 7. 安全说明

- **零入站暴露**：服务端仅监听 `127.0.0.1`；cloudflared 只发起**出站**连接到 Cloudflare 边缘 → Windows 防火墙**不需要任何入站规则**，路由器不需要端口映射。
- **HTTPS**：由 Cloudflare 终结，浏览器直接 `https://` 访问；MAA 端点走域名即无明文 HTTP 告警。
- **SSE**：`GET /api/events` 自带 **15 秒保活 ping**，经 Cloudflare 代理不会被空闲超时掐断，无需额外配置。
- **上传体积**：截图以 Base64 上报，单请求极端可达数十 MB；服务端 bodyLimit 100MB，Cloudflare 代理单请求上限 **100MB**——本项目远低于该上限，CF 侧无需任何调整。
- **鉴权层级**：MAA 协议端点按 `user`（= `maaUserToken`）校验（不匹配 403）+ 设备首次绑定人工批准（未批准 401）；仪表盘 API 全部过 `dashboardToken`；StopTask / Settings 类指令需二次确认（`confirm: true`）。
- 凭据清单（全部不入库）：`server\config.json`（双 token）、`%USERPROFILE%\.cloudflared\cert.pem`、隧道凭据 json。

## 8. 故障排查

| 现象 | 排查 / 处理 |
|---|---|
| **端口被占用**（start.ps1 启动失败） | 先执行 `Get-NetTCPConnection -LocalPort 24325 -State Listen`，从结果取 `OwningProcess` 列，再 `Get-Process -Id <PID>` 看进程名；是残留旧服务 → `Stop-Process -Id <PID>`；是别的程序 → 改 `server\config.json` 的 `port` |
| **浏览器访问域名 502** | tunnel 通但回源失败：先确认 MAARemote 在跑（§2 的 401 自检）；没在跑 → `start.ps1` 或 `nssm start MAARemote`。`cloudflared tunnel info maa-remote` 看连接数 |
| **域名打不开 / tunnel 未连接** | `Get-Service cloudflared` 看服务；服务启动失败 → 检查 §3.6 的 systemprofile 路径里有没有 `config.yml` **和** 凭据 json；前台 `cloudflared tunnel run maa-remote` 看报错 |
| **MAA getTask 收到 401** | 设备未批准：仪表盘 pending 列表批准（先与 MAA 界面设备标识符核对）；批准后立即生效 |
| **MAA 收到 403** | `user` 不匹配：MAA「用户标识符」≠ `config.json` 的 `maaUserToken`，重新复制粘贴 |
| **仪表盘 API 401** | 未带/带错 `dashboardToken`（Bearer 头或 `?token=`，值看 `server\config.json`） |
| **1Password 锁定导致 git 提交失败**（报 `op-ssh-sign ... failed to fill whole buffer`） | 单次绕过：`git -c commit.gpgsign=false commit ...`（不改持久配置；解锁 1Password 后可恢复正常签名） |
| **pwsh 中文输出乱码** | 显示层问题（UTF-8 输出被按 GBK 解码），不影响功能与文件落盘；改善：先执行 `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()` 或 `chcp 65001` |
| **改了 config.json 不生效** | 重启服务端进程（`Ctrl+C` 后重跑 start.ps1，或 `nssm restart MAARemote`） |

## 9. 上线检查清单（逐项勾选）

- [ ] `node --version` ≥ 18、pwsh 7 可用
- [ ] `pwsh -NoProfile -File start.ps1` 启动成功，`curl.exe` 自检 `/api/overview` 返回 401
- [ ] 已全局替换 `maa.example.com` 为真实子域名（本文档 + `deploy\cloudflared-config.yml`）
- [ ] `cloudflared tunnel login / create / route dns` 完成，前台 `tunnel run` 试跑 401 自检通过
- [ ] `cloudflared service install` 完成，systemprofile 路径已放 `config.yml` + 凭据 json，`Get-Service cloudflared` 运行中
- [ ] （可选）NSSM 已注册 MAARemote 服务并启动，日志目录 `logs\` 可写
- [ ] 电源计划「接通电源时休眠 = 从不」
- [ ] MAA「远程控制」两个端点 + 用户标识符（`maaUserToken`）已填，域名已替换
- [ ] MAA 首连 401 → 仪表盘 pending 核对设备标识符 → 批准 → MAA 开始取任务
- [ ] 浏览器打开 `https://<真实域名>` 能看到仪表盘（带 dashboardToken）
