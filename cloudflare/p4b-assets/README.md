# MAARemote 边缘静态资源 Worker（可选）

仓库的 web/ 已自带下面四个文件，本机或没有 Access 保护的部署不需要这个 Worker。只有整站被 Cloudflare Access 登录保护、又要用 iPhone 后台推送时才部署它。public/ 与 web/ 下的同名文件内容必须一致，测试会检查。

这个 Worker 只发布四个不含秘密的静态文件，让 iPhone 主屏幕 Web App 在不被 Access 登录页拦截的情况下注册 Service Worker：

- /sw.js
- /manifest.webmanifest
- /icons/icon-192.svg
- /icons/icon-512.svg

它通过三条精确的 Cloudflare Route（/sw.js、/manifest.webmanifest、/icons/*）挂到你的域名。/、/api/*、/maa/* 不在路由中，继续走 Tunnel 和 Access。不存在的图标返回 404。

## 结构

- public/：四个静态文件，内容与 web/ 下的同名文件一致，不含 Token、密钥、订阅信息或任务数据。
- src/index.js：对 /sw.js 和 /manifest.webmanifest 通过 assets.run_worker_first 显式设置 UTF-8 的 Content-Type，避免直接查看 sw.js 时中文注释乱码。
- wrangler.jsonc：配置模板，域名为 example.com。

## 部署

1. 复制模板：Copy-Item wrangler.jsonc wrangler.local.jsonc（本地副本已被 .gitignore 排除）。
2. 把 wrangler.local.jsonc 里三条 routes 的 maa.example.com 和 zone_name 改成你的域名。
3. npx wrangler login，然后 npx wrangler deploy --config wrangler.local.jsonc --dry-run 检查，再去掉 --dry-run 部署。
4. 在 Cloudflare Access 中为这四个精确路径增加 Bypass 策略。

验证命令和排障见仓库根目录 DEPLOY.md §10。
