# MAARemote 部署指南（DEPLOY）

> **占位符说明**：本文使用示例域名 **`maa.example.com`**。执行前请替换为你的域名，`deploy\cloudflared-config.yml` 同理；`<REPO_ROOT>`、`<NSSM_DIR>` 分别替换为仓库和 NSSM 的本机路径，`<TUNNEL_ID>` 替换为你创建的隧道 UUID。

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
| 域名 | NS 已托管 Cloudflare | 确认你的域名已完成 NS 托管 |
| MAA 桌面端 | 已能正常连模拟器跑任务 | 与本服务零耦合，先后无所谓 |

以下命令均在 **pwsh 7** 中执行，工作目录假设为仓库根目录 `<REPO_ROOT>`（请替换为你本机的仓库路径）。

## 2. 启动服务端

```powershell
# 一键启动（自动：定位 server\ → 按需准备依赖 → 端口占用检测 → 前台启动）
pwsh -NoProfile -File start.ps1
```

- **首次启动**会先校验 `package.json` / `package-lock.json`；没有健康成功标记或依赖加载检查失败时才准备依赖，成功标记保存在被忽略的 `server\.maaremote-deps-state.json`。随后自动生成 `server\config.json`（含两个**随机**令牌）与 `server\data\maa.db`。查看令牌：

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
- 停止：前台运行，**Ctrl+C** 即优雅退出（服务端自带 SIGINT/SIGTERM/SIGBREAK 处理）；后台常驻与开机自启见 §6（`tray.ps1` 托盘），也可随时用 `pwsh -NoProfile -File tray.ps1 -Action stop` 停止。
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
%SystemRoot%\System32\config\systemprofile\.cloudflared\config.yml
```

因此需把 `config.yml` **和凭据 json** 一并复制过去（管理员 pwsh）：

```powershell
New-Item -ItemType Directory -Force -Path "$env:SystemRoot\System32\config\systemprofile\.cloudflared" | Out-Null
Copy-Item -LiteralPath "$HOME\.cloudflared\config.yml" -Destination "$env:SystemRoot\System32\config\systemprofile\.cloudflared\"
Copy-Item -LiteralPath "$HOME\.cloudflared\<TUNNEL_ID>.json" -Destination "$env:SystemRoot\System32\config\systemprofile\.cloudflared\"
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
- 任务完成通知（后台推送为可选功能）：打开 HTTPS 域名后，先把页面添加到手机主屏幕，再从主屏幕 Web App 的“设置与工具”点击“开启后台推送”，允许通知并等待“已开启”。页面打开时通知仍走既有页面补发；后台 Web Push 只发送 `task_finished`，内容为任务名称、成功/失败和任务级耗时。

### 5.1 Cloudflare Access 与后台推送（可选）

本节和 §10 只在你要用 iPhone 后台推送、并且用 Cloudflare Access 保护整站时才需要；不使用后台推送可以整节跳过。静态文件（sw.js、manifest、图标）已放在 web/，由 Node 服务提供；没有 Access 保护的部署，或者只在页面打开时用通知，都不需要 Worker。

安全模型是 Cloudflare Access 登录加 MAARemote dashboardToken 双层鉴权。未登录访问页面或 /api/* 返回 302 是预期结果。

Web Push 分两个阶段：

- 登记订阅：用户在已通过 Access 登录的同源页面中调用 /api/push/*，这些接口继续要求 dashboardToken。
- 投递：服务端把加密载荷直接发给 Apple、FCM 或 Mozilla 的 Push Service。它们不会回调本域名，所以 /api/push/* 不需要对匿名用户开放。

iOS 主屏幕 Web App 注册 Service Worker 时，如果 /sw.js、/manifest.webmanifest 或图标被 Access 重定向到登录页，注册会失败，界面显示“后台推送开启失败”。处理办法是只让这四个不含秘密的静态文件匿名可读，并由 Cloudflare 边缘直接提供，不回源本机：

- 四个文件由 cloudflare/p4b-assets/ 里的 Worker 提供（内容与 web/ 下的同名文件一致），部署步骤见 §10。
- 在 Access 中只为这四个精确路径配置 Bypass 策略（/sw.js、/manifest.webmanifest、/icons/icon-192.svg、/icons/icon-512.svg），不使用通配符。
- 不要放行 /、/api/* 和 /maa/*。/maa/* 是 MAA 机器协议，需要单独的机器鉴权设计。
- 这四个文件不含 Token、密钥、订阅信息或任务数据。

Cloudflare Tunnel 的已发布应用程序路由仍把 /、/api/*、/maa/* 和前端静态资源送到 http://127.0.0.1:24325，兜底规则返回 404。

未登录检查：

~~~powershell
curl.exe -s -o NUL -w "%{http_code}" https://<你的域名>/                          # 期望 302
curl.exe -s -o NUL -w "%{http_code}" https://<你的域名>/sw.js                     # 期望 200
curl.exe -s -o NUL -w "%{http_code}" https://<你的域名>/api/push/vapid-public-key # 期望 302
~~~

登录后，/api/push/* 仍须携带 Authorization: Bearer <dashboardToken>，无 token 返回 401。

### 5.2 iPhone 后台推送实测

先在同源 HTTPS 页面或主屏幕 Web App 中完成 Cloudflare Access 登录，并确认页面可以加载；不需要关闭 Access 或创建公开 Bypass。

1. 用 Safari 打开 HTTPS 仪表盘，选择“添加到主屏幕”。
2. 从主屏幕启动 Web App，在“设置与工具”点击“开启后台推送”，允许通知。
3. 记录订阅时间和服务端注册响应；确认页面显示“已开启”。
4. 上滑清除 Web App、锁屏；在电脑上用下面的测试工具模拟 MAA HTTP，触发一个 `task_finished`，等待 1 分钟。工具只使用当前服务端的 `/maa/getTask`、`/maa/reportStatus` 和仪表盘 API，不连接真实 MAA；必须显式传入确认参数。

   ```powershell
   pwsh -NoProfile -Command "node .\server\tools\trigger-test-task-finished.js --confirm-test-task --status SUCCESS"
   ```

   工具默认生成唯一测试设备名并自动批准；如需标明设备可追加 `--device p4b-iphone-test`。失败路径可改成 `--status FAILED`。使用前确认 `start.ps1` 启动的是要验收的服务实例。
5. 记录 iOS 版本、安装方式、权限状态、订阅时间、触发时间和送达时间。苹果推送是 best-effort，可能延迟、合并或丢弃；本项目不承诺必达，也不承诺 MAA 没有提供的子步骤进度。

后台推送与页面补发共用同一份 IndexedDB 投递记录，按 task_id 去重：锁屏时收到后台推送后，重新打开 Web App 不会再收到同一任务的第二条通知。

## 6. 可选的桌面控制与托盘常驻（不属于核心启动链）

基础部署只有一条启动链：`start.ps1` 启动 Node 服务，Node 同源托管 `web/` 前端，用户使用浏览器访问仪表盘。前端不需要单独进程，托盘和托盘守护也不参与这条基础启动链。

桌面层按需要再启用：`tray.ps1` 提供托盘界面和命令行管理；`tray-guard.ps1` 由 Windows 计划任务拉起，只监督托盘。守护退出、恢复或卸载都不结束、不重启 Node 服务，Node 的常驻方式应独立选择。

- **Node 服务**是 MAA 的数据通道，必须持续运行；托盘退出不应影响已经运行的服务。
- **tray.ps1**是可选管理界面，不是服务存活的唯一保障，也不是项目启动前置条件。
- **tray-guard.ps1 + 计划任务**是可选 P2 增强项，默认关闭，不是默认部署步骤。
- 每个组件只选择一种自动恢复方式。托盘的 Run 键自启与计划任务守护不要同时启用；服务端也不要同时由 NSSM 和计划任务托管。
- 安装前先用 `-WhatIf` 查看任务定义；默认不注册任务，也不迁移现有 Run 自启。

### 6.1 可选：系统托盘 tray.ps1（桌面管理）

仓库根目录的 `tray.ps1` 是「托盘 GUI + 命令行」双形态一体脚本：无参数运行即托盘常驻，带 `-Action` 即命令行工具。状态判定与 `start.ps1` 同一套真相源（`server\config.json` 的 `port` + `/api/overview` 无 token 恒 401），只有三种状态：**运行中 / 已停止 / 端口被占用**。

**日常使用（托盘）**：

```powershell
pwsh -NoProfile -File tray.ps1
```

任务栏托盘出现 MAARemote 图标（**绿 = 运行中、灰 = 已停止、红 = 端口被占用**），悬停显示状态，右键菜单：状态行、启动 / 停止 / 重启 Remote、开机自启勾选、退出。菜单「退出」仅关闭托盘，**不停止服务**（服务是独立进程，MAA 轮询不中断）。

**命令行（可脚本化；退出码 成功 = 0 / 失败 = 1）**：

```powershell
pwsh -NoProfile -File tray.ps1 -Action status          # 例：STATUS=running PID=1234 PORT=24325
pwsh -NoProfile -File tray.ps1 -Action start           # 已运行则幂等跳过；端口被占用则拒绝
pwsh -NoProfile -File tray.ps1 -Action stop            # 按端口找 PID 结束（仅本服务，占用者拒绝杀）
pwsh -NoProfile -File tray.ps1 -Action restart
pwsh -NoProfile -File tray.ps1 -Action autostart-on    # 开机自启（写 HKCU Run 键，无需管理员）
pwsh -NoProfile -File tray.ps1 -Action autostart-off
```

要点：

- **开机自启（可选）**：`-Action autostart-on`（或托盘菜单勾选「开机自启」）写入当前用户 Run 键 `HKCU\...\CurrentVersion\Run\MAARemoteTray`，登录后启动托盘；`autostart-off` 取消。它只保证登录时启动一次，不负责托盘异常退出后的恢复。
- **接管语义**：不关心服务由谁启动——`start.ps1` 或手动 `node src\index.js` 先起的服务，托盘/CLI 照样显示「运行中」并可停止（按端口找 PID，401 探测确认是本服务）。
- **后台运行**：托盘/CLI 启动的服务是隐藏窗口进程，stdout/stderr 写入 `logs\service-out-<时间戳>.log` / `service-err-<时间戳>.log`（每次启动新文件，`logs\` 已被 .gitignore 排除）。
- **停止方式**：托盘/CLI 的停止为强制结束进程；SQLite 已开 WAL（`server\src\db.js`），已提交数据不受影响，可放心用。
- **限流友好**：托盘状态轮询 10 秒一次、仅端口被监听时才探测，不会触发 `/api/*` 的 401 失败限流（同 IP 60 秒 20 次）。
- 如果需要桌面管理，建议先按 §2 用 `start.ps1` 跑通一次（确认依赖准备与服务能正常起），再启动托盘；不需要托盘时可一直使用 `start.ps1`。

### 6.2 可选：Windows 计划任务守护托盘（默认关闭）

P2 已实现但默认关闭。这个组件只在用户明确需要登录后自动显示托盘、并希望托盘异常时有限恢复时才安装。未安装或未启用它不会影响 Node 服务和浏览器前端。`tray-task.ps1` 只管理当前用户的一个项目任务，`tray-guard.ps1` 只监督 `tray.ps1`，不会启动、停止或重启 Node 服务。任务使用当前用户交互式登录令牌、`Limited` 权限，不保存密码；执行文件、脚本路径和工作目录均使用绝对路径，因此仓库路径可以包含空格和中文。

任务定义固定为：当前用户登录触发；运行不限时；重复实例 `IgnoreNew`；禁止 Task Scheduler 使用 `TerminateProcess` 强杀任务；计划任务本身不配置 `RestartOnFailure`。守护进程只对托盘写出与本次子进程 PID、启动标识、时间戳一致的 `initialization_exception` 或 `runtime_exception`，且退出码非零时执行内部恢复；最多重试 3 次，每次间隔 60 秒。手动退出、正常退出、重复启动、主动停止/卸载、无法确认的强制终止、状态损坏或日志不可读都不会被当成可确认异常。主动停止和卸载通过命名事件请求托盘自行清理；5 秒内未优雅退出时返回未确认并保留任务，不强杀进程。

先预览：

```powershell
pwsh -NoProfile -File .\tray-task.ps1 -Action status
pwsh -NoProfile -File .\tray-task.ps1 -Action install -WhatIf -MigrateRun
```

初学者可使用仓库根目录的 安装 MAARemote 托盘守护.cmd：右键该文件，选择以管理员身份运行。该 CMD 文件只包含英文 ASCII、无 BOM、CRLF，并通过 `%~dp0` 定位同目录的 PowerShell 入口，因此文档不依赖固定仓库路径，仓库路径可以包含空格或中文。它只调用 install-tray-guard.ps1，先做只读预检，再注册当前用户的交互式登录任务，并在安装后回读任务身份和 Run 状态；不会启动托盘、Node 服务或修改未知任务。安装失败时窗口会保留错误和 RESULT_JSON。若当前用户是 Windows 内置 Administrator，Windows 可能忽略任务的 LeastPrivilege，入口会显示警告。

正式安装会注册任务并迁移本项目已有的 `HKCU\...\Run\MAARemoteTray`，需要显式执行 `-MigrateRun`；顺序是注册并核验任务、记录任务定义指纹、写入迁移回滚记录、删除已核验的 Run 值、写入迁移完成记录。任一步失败会尝试恢复原值并只清理本次创建且仍通过身份核验的任务。安装遇到同名非本项目任务或非本项目 Run 值会拒绝覆盖。停止会先禁用已核验的项目任务，再请求守护退出；卸载会再次核验任务身份，只有同一任务定义指纹的迁移记录才允许恢复 Run 值。任务已经不存在时不会凭旧记录恢复用户后来删除的 Run 值。

```powershell
pwsh -NoProfile -File .\tray-task.ps1 -Action install -MigrateRun
pwsh -NoProfile -File .\tray-task.ps1 -Action stop
pwsh -NoProfile -File .\tray-task.ps1 -Action uninstall
```

卸载只处理身份标记、根路径、命令行和当前用户均匹配的本项目任务；只有存在本项目、且任务定义指纹匹配的迁移记录时才恢复原 Run 值。状态和退出证据写入 `logs\tray-guard-state.json`、`logs\tray-guard-events.log`，托盘自身证据仍在 `logs\tray-state.json`、`logs\tray-events.log`。它不替代 Node 服务的常驻方案，也不应与 Run 键自启并用。

### 6.3 可选：NSSM 注册 Windows 服务（无登录会话场景）

托盘方案要求一个**已登录的用户会话**（Run 键随登录触发）。若需要**不登录也常驻**（如重启后无人值守自动上线），改用 NSSM 把服务端注册为 Windows 服务：

1. 下载 NSSM：<https://nssm.cc/release/nssm-2.24.zip>，解压后取 `win64\nssm.exe` 放到一个**仓库外**的固定目录（如 `<NSSM_DIR>`，避免二进制混入仓库），并在 PATH 中或用完整路径调用。
2. 管理员 pwsh 注册（`$node = (Get-Command node).Source` 先查 node 实际路径）：

   ```powershell
   nssm install MAARemote "$node" "src\index.js"
   nssm set MAARemote AppDirectory "<REPO_ROOT>\server"
   nssm set MAARemote AppStdout     "<REPO_ROOT>\logs\service-out.log"
   nssm set MAARemote AppStderr     "<REPO_ROOT>\logs\service-err.log"
   nssm set MAARemote AppStdoutCreationDisposition 4   # 追加写
   nssm set MAARemote AppStderrCreationDisposition 4
   nssm start MAARemote
   ```

   （`logs\` 已被 .gitignore 排除；用 NSSM 常驻后，日常不再需要 `start.ps1` 与托盘的启动动作，它们保留作前台运行/调试与状态查看用。）
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
| **托盘/CLI 显示「端口被占用」、启动或停止被拒** | `pwsh -NoProfile -File tray.ps1 -Action status` 看 PID：是残留的本服务旧进程 → `-Action stop`；是别的程序 → 改 `server\config.json` 的 `port`（托盘只杀经 401 探测确认的本服务进程） |
| **端口被占用**（start.ps1 启动失败） | 先执行 `Get-NetTCPConnection -LocalPort 24325 -State Listen`，从结果取 `OwningProcess` 列，再 `Get-Process -Id <PID>` 看进程名；是残留旧服务 → `Stop-Process -Id <PID>`；是别的程序 → 改 `server\config.json` 的 `port` |
| **浏览器访问域名 502** | tunnel 通但回源失败：先确认 MAARemote 在跑（§2 的 401 自检）；没在跑 → `start.ps1` 或 `nssm start MAARemote`。`cloudflared tunnel info maa-remote` 看连接数 |
| **域名打不开 / tunnel 未连接** | `Get-Service cloudflared` 看服务；服务启动失败 → 检查 §3.6 的 systemprofile 路径里有没有 `config.yml` **和** 凭据 json；前台 `cloudflared tunnel run maa-remote` 看报错 |
| **MAA getTask 收到 401** | 设备未批准：仪表盘 pending 列表批准（先与 MAA 界面设备标识符核对）；批准后立即生效 |
| **MAA 收到 403** | `user` 不匹配：MAA「用户标识符」≠ `config.json` 的 `maaUserToken`，重新复制粘贴 |
| **仪表盘 API 401** | 未带/带错 `dashboardToken`（Bearer 头或 `?token=`，值看 `server\config.json`） |
| **收不到任务完成通知** | 页面打开时先确认“浏览器实时连接中”和“任务完成通知=已开启”；后台推送再确认已在主屏幕 Web App 中完成 Access 登录、静态资源路由已包含 sw.js/manifest/图标、系统通知权限已允许且未开启勿扰/专注模式。已拒绝权限需在站点设置中重新允许；页面补发只含 30 分钟内的结果 |
| **1Password 锁定导致 git 提交失败**（报 `op-ssh-sign ... failed to fill whole buffer`） | 单次绕过：`git -c commit.gpgsign=false commit ...`（不改持久配置；解锁 1Password 后可恢复正常签名） |
| **pwsh 中文输出乱码** | 显示层问题（UTF-8 输出被按 GBK 解码），不影响功能与文件落盘；改善：先执行 `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()` 或 `chcp 65001` |
| **改了 config.json 不生效** | 重启服务端进程（`Ctrl+C` 后重跑 start.ps1，或 `nssm restart MAARemote`） |

## 9. 上线检查清单（逐项勾选）

- [ ] `node --version` ≥ 18、pwsh 7 可用
- [ ] `pwsh -NoProfile -File start.ps1` 启动成功，`curl.exe` 自检 `/api/overview` 返回 401
- [ ] 已全局替换 `maa.example.com` 为真实子域名（本文档 + `deploy\cloudflared-config.yml`）
- [ ] `cloudflared tunnel login / create / route dns` 完成，前台 `tunnel run` 试跑 401 自检通过
- [ ] `cloudflared service install` 完成，systemprofile 路径已放 `config.yml` + 凭据 json，`Get-Service cloudflared` 运行中
- [ ] （可选）桌面管理或常驻方案已配置：托盘 `tray.ps1` / Run 自启 / 计划任务守护（见 §6.1–§6.2）或 NSSM 服务（无登录会话场景，见 §6.3）；`logs\` 目录可写
- [ ] 电源计划「接通电源时休眠 = 从不」
- [ ] MAA「远程控制」两个端点 + 用户标识符（`maaUserToken`）已填，域名已替换
- [ ] （可选，仅 Access 保护下使用后台推送时）已按 §10 部署边缘 Worker，Access 只对四个静态路径配置 Bypass；未登录访问 / 返回 302，/sw.js 返回 200 且 MIME 正确，/api/overview 无 token 返回 302 或 401
- [ ] （可选）主屏幕 Web App 已开启后台推送，并按 §5.2 完成一次锁屏实测
- [ ] MAA 首连 401 → 仪表盘 pending 核对设备标识符 → 批准 → MAA 开始取任务
- [ ] 浏览器打开 `https://<真实域名>` 能看到仪表盘（带 dashboardToken）

## 10. 边缘静态资源 Worker（可选：Access 保护下的 iPhone 后台推送）

仓库的 web/ 已自带 sw.js、manifest.webmanifest 和两个图标，没有 Access 保护时不需要本节。cloudflare/p4b-assets/public/ 与 web/ 下的四个文件内容必须一致（测试会检查），修改其中一处时同步另一处并重新部署 Worker。

cloudflare/p4b-assets/ 是一个独立的 Cloudflare Worker（Workers Static Assets），只发布四个不含秘密的文件：/sw.js、/manifest.webmanifest、/icons/icon-192.svg、/icons/icon-512.svg。它通过三条精确 Route（/sw.js、/manifest.webmanifest、/icons/*）挂到你的域名；/、/api/*、/maa/* 不在 Route 中，继续走 Tunnel 和 Access。未知的图标路径返回 404。

Worker 代码只对 sw.js 和 manifest 显式设置 UTF-8 的 Content-Type，避免直接查看 sw.js 时中文注释乱码。不使用 KV、D1、队列，也不新增 npm 运行依赖。套餐额度和计费以 Cloudflare 当前账户规则为准。

### 10.1 部署

1. 进入目录并复制配置。仓库里的 wrangler.jsonc 只是模板（域名为 example.com），真实域名写在已被 .gitignore 排除的本地副本里：

   ~~~powershell
   cd cloudflare\p4b-assets
   Copy-Item wrangler.jsonc wrangler.local.jsonc
   ~~~

2. 编辑 wrangler.local.jsonc：把三条 routes 里的 maa.example.com 和 zone_name 改成你的子域名与主域名。
3. 登录并先做干跑检查，再部署：

   ~~~powershell
   npx wrangler login
   npx wrangler deploy --config wrangler.local.jsonc --dry-run
   npx wrangler deploy --config wrangler.local.jsonc
   ~~~

4. 在 Cloudflare Zero Trust 的 Access 中，为这四个精确路径增加 Bypass 策略（见 §5.1）。

### 10.2 验证

~~~powershell
curl.exe -sS -D - -o NUL https://<你的域名>/sw.js
curl.exe -sS -D - -o NUL https://<你的域名>/manifest.webmanifest
curl.exe -s -o NUL -w "%{http_code}" https://<你的域名>/icons/icon-192.svg
curl.exe -s -o NUL -w "%{http_code}" https://<你的域名>/icons/not-exist.svg
curl.exe -s -o NUL -w "%{http_code}" https://<你的域名>/
~~~

期望：

- sw.js 返回 200，Content-Type 为 text/javascript; charset=utf-8。
- manifest 返回 200，Content-Type 为 application/manifest+json; charset=utf-8。
- 图标返回 200，类型为 image/svg+xml；不存在的图标返回 404。
- 根路径仍返回 Access 的 302。

想确认这四个文件确实由边缘提供而不是本机：把 web/ 下对应的四个文件临时改名，再请求公网路径，响应仍应正确；本机同路径此时会退回首页 HTML。验证后改回原名。

### 10.3 排障

- sw.js 中文注释乱码：先看响应头有没有 charset=utf-8，并用 SHA-256 对比线上响应体与 cloudflare/p4b-assets/public/sw.js；不要直接重新编码源文件。
- iPhone 仍提示注册 Service Worker 失败：确认 Access 的 Bypass 只命中这四个路径且已在应用级保存，匿名 curl.exe 返回 200 而不是 302。
- 更新前端或 Service Worker 后：完全退出并重新打开主屏幕 Web App，新版 Service Worker 才会激活。
