# 安全政策

## 报告漏洞

请不要在公开的 Issue 或讨论区描述安全问题。请使用 GitHub 的私密漏洞报告：打开本仓库的 **Security** 标签页，点击 **Report a vulnerability**，提交描述、复现步骤和影响范围。

这是个人维护的项目，没有固定的响应时限；我会尽力在收到报告后尽快确认，并在修复后与你协商披露方式。请不要在报告中附带真实的 Token、设备密钥、订阅 endpoint、Cloudflare 凭据或截图原图。

## 受支持的版本

只维护 main 分支的最新代码，不为旧版本单独发布补丁。

## 欢迎报告的问题

- 仪表盘 API 的鉴权绕过，或 dashboardToken、maaUserToken、设备密钥在日志、响应、错误信息中泄露。
- /maa/getTask、/maa/reportStatus 的鉴权、设备批准流程或二次确认被绕过。
- 静态文件托管中的路径穿越，或 /api、/maa 路径被静态托管接管。
- 前端 XSS、截图或任务内容导致的注入。
- Web Push 订阅接口的越权、订阅信息泄露，或推送内容包含任务名称、结果、耗时以外的数据。
- 依赖中的已知漏洞在本项目中真实可利用。

## 不在范围内

- 部署方自己的 Cloudflare、Windows 或网络配置问题，例如把 /api/* 加入了匿名放行策略，或把 server/config.json 提交到了公开仓库。
- 需要已经取得本机管理员权限、或已经拿到有效 dashboardToken 才能完成的攻击。
- 对 MAA 本体、安卓模拟器、Apple/Google/Mozilla Push Service 本身的漏洞，请向相应项目报告。
- 没有实际影响的纯扫描器告警，以及对本服务的流量压测或 DoS 测试。

## 部署时请自查

- server/config.json、server/data/（含 push.json、数据库、截图）只应保留在本机，已被 .gitignore 排除，不要强制提交。
- 公网部署使用 HTTPS，并优先用 Cloudflare Access 保护仪表盘；服务端只监听 127.0.0.1，不需要开放入站端口。
- 不要把 /api/* 或 /maa/* 加入匿名放行策略。可选的边缘 Worker 只公开 sw.js、manifest 和两个图标这四个不含秘密的文件。
- 怀疑 Token 泄露时，修改 server/config.json 中的 dashboardToken 或 maaUserToken 并重启服务，同时在 MAA 端更新用户标识符。

更多部署细节见 [DEPLOY.md](DEPLOY.md) 的「安全说明」一节。