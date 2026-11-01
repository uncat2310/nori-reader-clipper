# Nori Reader & Clipper

一个 Manifest V3 Chrome 扩展：提供简洁阅读模式，并把网页选中文本或正文保存到 Notion。

## 功能

- 阅读模式：正文排版、字号调整、深色模式和退出按钮。
- 剪藏选中文本或整篇正文，保存原文链接、作者、标题层级、段落、列表、引用、代码块和图片链接。
- **零配置直接登录 Notion（推荐）**：直接检测或唤醒浏览器 Notion 账号登录，自动读取工作区页面与数据库，并支持一键创建「📚 Nori 网页剪藏」页面，无需手动复制 Database ID，也无需部署任何外部服务。
- 同时支持 **Notion 官方集成密钥一键连接**（粘贴密钥即可自动拉取数据库并自动识别标题列）以及 **本地直连 OAuth 2.0 授权弹窗**。

## 快速使用（零配置直接登录）

1. 在 Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本文件夹 `nori-reader-clipper`（若之前已加载，点击扩展卡片上的 **刷新 ↻** 按钮即可）。
3. 点击浏览器右上角的 **Nori** 插件图标：
   - 如果你的 Chrome 已经登录了 `notion.so`，插件会**自动连接你的 Notion 工作区**并列出可保存的页面与数据库。
   - 如果尚未登录，点击弹窗或设置页中的 **「直接登录 Notion 账号」**，在弹出的 Notion 窗口完成登录即可自动绑定。
4. 在下拉菜单中选择要保存到的页面或数据库（或选择 **「✨ 自动创建『📚 Nori 网页剪藏』页面」**），即可在任意文章页使用阅读模式或一键剪藏。

### 1. 加载扩展并获取扩展 ID

先在 Chrome 打开 `chrome://extensions`，开启「开发者模式」，选择「加载已解压的扩展程序」，加载本文件夹。复制扩展详情页显示的 ID，后面配置 Worker 时要用。

### 2. 创建 Notion Public Connection

在 Notion Developer Portal 创建 Public Connection：

- OAuth redirect URI：`https://<你的-worker>.workers.dev/oauth/callback`
- Capabilities：开启读取内容和插入内容
- 复制 Client ID 和 Client Secret。Client Secret 只放入 Cloudflare Worker secret，不能放进扩展代码。

Public Connection 的授权页会让用户选择可分享给该连接的页面和数据库。授权用户需要对目标页面/数据库有完整访问权限。OAuth 回调地址必须与 Developer Portal 中注册的地址完全一致。

### 3. 部署 Cloudflare Worker

进入 `oauth-worker` 目录，先登录 Wrangler：

```sh
npx wrangler login
```

把 `oauth-worker/wrangler.toml` 中的 `EXTENSION_ID` 和 `NOTION_REDIRECT_URI` 两项替换为实际值。Worker URL 通常是 `https://nori-notion-oauth.<你的 Cloudflare 子域>.workers.dev`。

将 Notion Client ID 和 Client Secret 作为 Cloudflare secrets 写入：

```sh
npx wrangler secret put NOTION_CLIENT_ID
npx wrangler secret put NOTION_CLIENT_SECRET
npx wrangler deploy
```

按提示粘贴对应值。确认 Notion Developer Portal 中注册的 OAuth redirect URI 与 `NOTION_REDIRECT_URI` 完全相同。

### 4. 配置扩展并重新加载

编辑 `oauth-config.js`：

```js
globalThis.NORI_OAUTH_CONFIG = Object.freeze({
  clientId: "你的 Notion Client ID",
  workerBaseUrl: "https://nori-notion-oauth.你的-cloudflare-子域.workers.dev"
});
```

在 `chrome://extensions` 点击扩展的重新加载按钮。打开扩展设置，点「使用 Notion 登录」，完成 Notion 授权后选择剪藏数据库。

## 日常安装

开发模式下，打开 `chrome://extensions`，选择「加载已解压的扩展程序」，加载 `nori-reader-clipper` 文件夹即可。Chrome 内部页面、网上应用店和部分受保护页面不允许扩展注入脚本。

## 权限与数据流

- `activeTab` 和 `scripting`：用户点击扩展后读取当前网页并显示阅读模式。
- `storage`：本机保存 Notion token、工作区和目标数据库。
- `identity`：通过 Chrome OAuth 窗口完成 Notion 登录。
- `https://api.notion.com/*`：写入剪藏内容和读取已授权数据库列表。
- OAuth Worker 域名权限：用户连接时仅请求配置的 Worker 域名。

OAuth Worker 不接收网页剪藏正文；剪藏正文直接从扩展发送到 Notion API。
