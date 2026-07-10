<div align="center">

# ✨ LumiMuse

**让 TA 慢慢填满你的房间。**

*A quiet, elegant AI companion — built for those who want something that feels real.*

[![Next.js](https://img.shields.io/badge/Next.js_16-black?style=flat-square&logo=next.js)](https://nextjs.org)
[![React](https://img.shields.io/badge/React_19-61DAFB?style=flat-square&logo=react&logoColor=222)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS_v4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://www.sqlite.org)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-a78bfa?style=flat-square)](LICENSE)

[English](README.en.md) · 中文

</div>

---

> LumiMuse 是一个偏「陪伴感」的 AI 角色聊天工具。它不是只追求把消息发出去，而是围绕角色、长期记忆、上下文总结、图片生成、移动端体验和数据自主管理，打磨出一个更适合长期使用的私人陪伴空间。
>
> 你可以创建不同角色，给 TA 设置性格、背景、开场白、示例对话和生图标签；也可以让 TA 在聊天中逐渐记住关于你、你们关系和共同经历的细节。项目支持本地运行，也支持用 Docker 部署到自己的服务器，角色、对话、记忆和生成图片都保存在你自己的设备或服务器里。

---

## 项目预览

| 首页 | 对话 |
|------|------|
| ![首页](assets/首页.png) | ![对话](assets/对话.png) |

| 编辑角色 | 记忆管理 | 设置 |
|------|------|------|
| ![编辑角色](assets/编辑角色.png) | ![记忆管理](assets/记忆管理.png) | ![设置](assets/设置.png) |

---

## 功能一览

| | 功能 | 说明 |
|:---:|------|------|
| 🎭 | **角色系统** | 独立性格、开场白、示例对话、生图标签，每个角色拥有独立对话与记忆，支持拖拽排序 |
| 💬 | **聊天体验** | 流式输出、消息编辑/删除/多版本重新生成、图片与文本附件、手动总结 |
| 🧠 | **长期记忆** | 自动提取、整理、画像、归档和索引记忆，支持本地工作记忆、向量检索、AI 整理与记忆画像 |
| 🎨 | **AI 生图** | 支持 SD WebUI / NovelAI / ComfyUI / 自定义 API,版本历史与图片管理 |
| 🔌 | **多供应商** | 保存多套 API 配置一键切换,聊天输入框直接切模型,适合在不同模型间对比 |
| 🔍 | **搜索导航** | 全局消息搜索、日期搜索、中文包含搜索、结果定位高亮 |
| 📦 | **导入导出** | 角色与记忆和对话记录按需导出,轻量备份或完整迁移,可导入 SillyTavern 风格角色卡 JSON |
| 🧹 | **维护面板** | 设置页内置孤儿文件检测与清理,删除角色/对话时同步清理头像、生图、附件 |
| 📱 | **移动端** | 响应式布局、iOS 安全区域适配、触屏操作优化 |
| 🔒 | **访问保护** | 可选访问密码,签名 token + 常量时间比较 + SSRF 防护,公网部署友好 |

---

## 功能详情

### 🎭 角色系统

- 支持创建、编辑和删除角色
- 可配置头像、性格、场景、开场白、示例对话和系统提示词（给 AI 的基础设定）
- 支持生图标签字段，角色的画风、外貌和固定元素可以随角色一起保存
- 每个角色拥有独立对话和记忆，适合维护不同关系线
- 侧边栏支持拖拽排序，常用角色可以放在前面
- 支持导入 SillyTavern 风格的角色卡 JSON（仅 JSON 文件，不支持 PNG 内嵌格式），会读取常用字段如名称、描述、性格、场景、开场白、示例对话、系统提示词、标签等

### 💬 聊天体验

- 支持流式输出和非流式输出
- 支持停止生成，避免请求失控或继续写入无用回复
- 支持消息编辑、删除、重新生成和多版本切换
- 重新生成会保留旧版本，不会直接抹掉历史内容
- 支持纯文本消息、图片附件和文本附件
- 图片附件会以多模态内容进入上下文；文本附件会拼入上下文
- 支持复制对话、按对话刷新消息
- 支持手动总结上下文，把较长历史压缩为 summary，减少后续 token 占用

### 🧠 长期记忆

- 支持从对话中提取长期记忆，并按角色写入记忆库
- 记忆分类包括关系动态、话题历史、基础信息、偏好习惯、人格特质和重要事件
- 支持按消息数、固定时间间隔、关键词三种方式触发记忆提取，可独立开关
- 支持设置是否把记忆注入聊天上下文，以及限制最多注入多少条
- 记忆管理页支持分页、搜索、分类、排序、编辑、删除和标签管理
- 支持单个对话忽略记忆提取，避免临时测试或无关对话污染记忆
- 增强记忆引擎支持本地工作记忆、memory profile（结构化角色画像）、embedding 向量索引和 reranker 重排，可按隐私偏好关闭外部增强
- 设置页提供记忆索引状态、重建索引、索引未索引记忆、重试失败索引、停止当前索引任务和清空索引等维护操作
- AI 整理可批量检查活跃记忆，修正分类、重要度、情绪权重和标签，并在修改后自动重建相关索引
- AI 归档可将旧记忆压缩为摘要记忆，被归档记忆保留可追溯批次，摘要记忆会自动进入索引
- 记忆画像支持从记忆初始化、队列处理、手动编辑、版本切换和版本删除，便于维护长期关系状态
- 后台任务可单独选择供应商和模型；使用 DeepSeek 作为后台模型时可关闭后台推理，降低 AI 整理、画像更新、归档、总结和生图 prompt 生成的耗时

### 🎨 AI 生图

- 支持 Stable Diffusion WebUI、NovelAI、ComfyUI、自定义 API 四种生图引擎
- 支持全局质量标签、负面提示词、尺寸、采样器、步数等常用参数
- 支持根据聊天消息生成图片提示词
- 支持自动生图关键词，例如「画」「生图」「来一张」「看看」
- 支持图片版本历史，重新生成不会直接丢掉旧图
- 支持对话内图片预览、上一张 / 下一张切换、删除当前版本
- 支持角色图片管理中的批量删除和版本保留
- 生图过程中显示占位图与进度提示，失败时保留旧图避免误删

### 🔌 多供应商配置

- 设置页支持保存多套 API 配置（不同服务商、不同模型、不同密钥）
- 聊天输入框可临时切换当前会话使用的模型，方便对比效果
- 切换供应商不会改动已有的消息历史

### 🔍 搜索与导航

- 支持全局搜索聊天消息
- 搜索结果支持分页加载，避免结果过多时卡顿
- 支持中文关键词包含搜索，减少中文分词漏搜
- 支持日期搜索，例如 `2026年4月1日`、`2026年4月1`、`2026/4/1`、`2026.4.1`
- 支持从搜索结果直接跳转并高亮定位到原消息

### 📦 数据导入导出

- 支持导出角色、记忆、对话记录和消息
- 支持按需选择导出内容，便于轻量备份或完整迁移
- 支持导入备份文件，适合在本地环境和服务器环境之间迁移
- 兼容 SillyTavern 风格角色卡 JSON 的常用字段一键导入（仅 JSON，不读 PNG 内嵌元数据；character book、深度参数等扩展字段不一定能完整还原）
- 数据库使用 SQLite（单文件数据库），默认保存在 `data/lumimuse.db`

### 🧹 维护面板

- 设置页提供维护区块，可手动检测孤儿文件（不再被任何角色或消息引用的头像、生成图、附件）
- 检测后可一键清理，避免长期使用后磁盘空间被无用文件占满
- 删除角色或对话时会同步清理对应的图片与附件，不再留垃圾

### 📱 移动端与桌面端

- 响应式布局，兼顾桌面端宽屏和手机窄屏
- 移动端使用 `h-dvh` 适配 iOS Safari 地址栏变化
- 处理 safe-area（手机底部安全区域），避免输入框被系统手势区遮挡
- 触屏设备支持点击显示 / 隐藏图片和消息操作按钮
- 移动端记忆卡片、工具栏和对话切换抽屉做了紧凑布局优化

### 🔒 访问保护

- 支持通过 `ACCESS_PASSWORD` 设置访问密码
- 不设置访问密码时，应用透明访问，适合只在自己电脑上使用
- 部署到公网时建议一定设置访问密码
- 登录后下发 HMAC-SHA256 签名 token（不再把密码原文写入 cookie），可选配 `AUTH_SECRET` 让 token 在多副本部署时通用
- 密码校验使用常量时间比较，避免通过响应耗时差推测密码
- 默认不信任 `X-Forwarded-For`；只有可信反向代理会覆盖转发头且应用端口不得绕过代理直连时才设置 `TRUST_PROXY=1`。默认信任离应用最近的 1 个代理 hop，多级代理用正整数 `TRUST_PROXY_HOPS` 配置，系统从 XFF 右侧解析客户端地址
- 出站请求（生图、模型列表、总结、对话补全）经过 SSRF 防护，会做 DNS 解析与重定向逐跳校验，避免被外部地址引导到内网
- 自部署本地 LLM / SD WebUI 时可设置 `ALLOW_LOCAL_NETWORK=1`，显式放开 loopback、RFC1918、IPv6 ULA/site-local 与 `100.64.0.0/10`（CGNAT/overlay）；metadata/link-local、multicast、documentation、benchmark 和 reserved 地址仍会拒绝

---

## 技术栈

| 层级 | 技术 |
|:---:|------|
| 应用框架 | Next.js 16（React 全栈框架） |
| 前端 | React 19（界面组件库） |
| 语言 | TypeScript（带类型检查的 JavaScript） |
| 样式 | Tailwind CSS v4（工具类 CSS 框架） |
| 数据库 | SQLite + better-sqlite3（本地单文件数据库和 Node.js 驱动） |
| AI 接入 | OpenAI Chat Completions API 格式（多供应商配置切换） |
| 字体 | Quicksand + LXGW WenKai Screen（霞鹜文楷屏幕版） |
| 容器化 | Docker + Docker Compose（容器部署工具） |

---

## 快速开始

### 环境要求

- Node.js **>=20.18.1**
- npm（Node.js 自带的包管理器）
- 一个兼容 OpenAI Chat Completions API 格式的模型服务
- 如需 Docker 部署，需要 Docker 和 Docker Compose

CI 会在 Node **20.18** 和 **Node 24** 上运行验证；本地建议使用 Node 20.18.1 或更新版本。

### 本地使用

```bash
git clone https://github.com/in30mn1a/LumiMuse.git
cd LumiMuse
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)，进入设置页填写模型接口信息即可开始使用。

数据库会自动创建在 `data/lumimuse.db`。

### 本地生产启动

```bash
npm run build
npm run start:local
```

`npm run start:local` 使用 Next.js 的 `next start`（Next.js 生产服务器），适合在源码工作区本地检查生产构建。

`npm start` 等同于 `npm run start:standalone`，会运行 `.next/standalone/server.js`，用于检查 Next.js standalone（独立运行包）输出。Docker 镜像会把 `.next/standalone` 复制到容器工作目录，并在容器内直接执行 `node server.js`。

### Windows 快速启动

项目根目录提供了 `Start.bat`。如果你已经安装依赖，可以双击它快速启动 LumiMuse。

---

## 首次使用指南

### 1️⃣ 配置模型接口

进入设置页，填写：

- `API Base` — 接口地址，例如 `https://api.openai.com/v1`，或你的中转 / 本地模型地址
- `API Key` — 模型服务密钥
- `Model` — 模型名称，例如服务商提供的聊天模型名
- `Temperature` — 温度参数，数值越高回复越发散，越低越稳定
- `Max Tokens` — 单次回复最多生成的 token 数
- `Context Window` — 上下文窗口大小，也就是模型最多能接收的大致 token 数

填写后可以在模型选择处拉取模型列表（如果你的服务商支持模型列表接口），也可以手动输入模型名。

### 2️⃣ 创建角色

在侧边栏创建角色，建议至少填写：

- **名称** — 角色显示名
- **开场白** — 新对话开始时的第一句话
- **性格 / 场景** — 帮助角色保持稳定人设
- **系统提示词** — 更明确地告诉 AI 应该如何扮演角色
- **生图标签** — 如果你会使用生图功能，建议写入角色外貌和画风标签

### 3️⃣ 开始对话

选择角色后即可创建对话。你可以：

- 直接发送文字
- 上传图片，让支持视觉的模型读取图片内容
- 上传文本附件，把文件内容作为上下文
- 对不满意的回复进行重新生成，并在不同版本间切换
- 在长对话中手动总结上下文，减少后续模型负担

### 4️⃣ 管理记忆

进入记忆管理页，可以查看角色已经记住的内容。建议定期检查并整理记忆：

- 删除错误或不想保留的记忆
- 编辑描述不准确的记忆
- 添加标签，方便后续搜索
- 按分类或关键词筛选

---

## Docker 部署

### 1. 准备环境变量

复制示例环境变量文件：

```bash
cp .env.local.example .env.local
```

编辑 `.env.local`：

```env
# 访问密码（部署到公网时强烈建议设置）
ACCESS_PASSWORD=your_password_here

# 可选：HMAC token 签名密钥（默认会从 ACCESS_PASSWORD 派生）
# 多副本部署或希望 cookie 跨重启不失效时建议显式设置
# AUTH_SECRET=use_a_long_random_string_here

# 可选：仅在可信反向代理覆盖 X-Forwarded-For 时启用
# TRUST_PROXY=1

# 可选：TRUST_PROXY=1 时默认信任最近的 1 个代理；多级代理设为正整数
# 应用端口不得绕过可信代理直接暴露到公网
# TRUST_PROXY_HOPS=2

# 可选：自部署本地 LLM / SD WebUI 时显式允许内网地址
# ALLOW_LOCAL_NETWORK=1
```

如果不设置 `ACCESS_PASSWORD`，应用不会要求登录。这个模式只建议在自己电脑或可信局域网内使用；生产 Docker 启动会 fail-fast 拒绝空密码或 `your_password_here` 这类占位值。

`docker-compose.yml` 会通过 `env_file` 默认读取 `.env.local`，所以上面的 `ACCESS_PASSWORD` / `AUTH_SECRET` 会注入容器环境；不需要额外执行 `docker compose --env-file ...`。如需使用其他文件，可设置 `LUMIMUSE_ENV_FILE=.env.production docker compose up -d --build`。

### 2. 启动服务

```bash
docker compose up -d --build
```

启动后打开 [http://localhost:3000](http://localhost:3000)

### 3. 持久化数据

`docker-compose.yml` 默认挂载以下目录：

| 宿主机目录 | 容器目录 | 用途 |
|------|------|------|
| `./data` | `/app/data` | 保存 SQLite 数据库 |
| `./public/generated` | `/app/public/generated` | 保存生成图片 |
| `./public/avatars` | `/app/public/avatars` | 保存角色头像 |
| `./public/attachments` | `/app/public/attachments` | 保存对话附件（图片 / 文本） |

只要这些目录还在，容器重建后数据也不会丢。容器以非 root 用户（UID 1001:1001）启动以减少攻击面，entrypoint 不再自动执行 `chown`。Linux 上使用 `./data` 这类 bind mount 时，请在首次启动前执行一次 `sudo chown -R 1001:1001 data public/generated public/avatars public/attachments`；如果改用 Docker named volume，Docker 会按镜像内目录属主初始化卷，通常不需要手动修权限。

Windows / macOS 下 Docker Desktop 会自动处理权限，直接 `docker compose up -d --build` 即可。

### 4. 更新版本

```bash
git pull
docker compose up -d --build
```

更新前建议先在应用内导出备份，或手动备份 `data/`、`public/generated/` 和 `public/avatars/`。

---

## 生图配置

进入设置页开启生图功能后，可以选择不同引擎。

### Stable Diffusion WebUI

适合本地部署 Stable Diffusion WebUI 的用户。

- 默认地址：`http://127.0.0.1:7860`
- 需要 WebUI 开启 API 功能
- 可设置模型、采样器、步数、CFG Scale（提示词引导强度）、宽高和负面提示词

> ⚠️ 如果 LumiMuse 在 Docker 容器中运行，而 Stable Diffusion WebUI 在宿主机运行，`127.0.0.1` 指的是容器内部，不是宿主机。此时需要把地址改成宿主机可访问地址，例如局域网 IP。

### NovelAI

适合使用 NovelAI 生图接口的用户。

- 需要填写 NovelAI API Key
- 可配置模型、采样器、噪声调度、步数、scale、尺寸、负面提示词和 artist tags

### ComfyUI

适合已有 ComfyUI 工作流的用户。

- 默认地址：`http://127.0.0.1:8188`
- 需要填写工作流 JSON
- 请确保工作流中提示词和输出节点与项目预期兼容

### 自定义 API

适合接入 OpenAI DALL·E 格式或其他兼容图片生成接口。

- 填写自定义接口地址
- 如接口需要鉴权，填写 API Key
- 配置模型名和图片尺寸

---

## 记忆系统

LumiMuse 的记忆不是简单把所有聊天都塞回上下文，而是做了提取和注入两步：

1. **提取** — 在满足触发条件后，后台任务会从对话中总结出值得长期保留的内容
2. **管理** — 记忆会进入角色的记忆库，你可以手动编辑、删除和打标签
3. **注入** — 下次聊天时，系统会取出记忆放入上下文，让角色「想起」这些内容

可配置项包括：

- 是否启用记忆注入
- 按消息数触发：例如每 3 条消息尝试提取一次
- 按时间触发：例如每 24 小时尝试提取一次
- 按关键词触发：例如出现「晚安」时触发
- 最大注入数量：限制每次聊天带入多少条记忆

如果某次对话只是测试模型、调提示词或聊了无关内容，可以把该对话设为忽略记忆，避免污染角色记忆库。

---

## 数据与隐私

LumiMuse 的核心数据保存在你自己的本机或服务器中：

- SQLite 数据库：`data/lumimuse.db`
- 生成图片：`public/generated/`
- 角色头像：`public/avatars/`
- 对话附件：`public/attachments/`

应用本身不会把你的角色、对话或记忆上传到 LumiMuse 作者的服务器。实际会发出的外部请求主要来自你自己配置的模型接口和生图接口。

如果你部署到公网，请务必：

- 设置 `ACCESS_PASSWORD`
- 确认 `ACCESS_PASSWORD` 不是空值或示例占位值；Docker 生产启动会直接拒绝这类配置
- 使用 HTTPS（加密访问协议），建议放在反向代理后面
- 只有可信反向代理会覆盖客户端转发头且应用端口不得绕过代理直连时，才设置 `TRUST_PROXY=1`；多级代理用 `TRUST_PROXY_HOPS` 配置可信 hop 数
- 定期备份 `data/`、`public/generated/`、`public/avatars/` 和 `public/attachments/`
- 不要把 `.env.local`、数据库文件或个人备份提交到公开仓库

---

## 备份与迁移

推荐使用应用内导出 / 导入功能迁移：

1. 在旧环境进入记忆管理或相关导出入口
2. 选择需要导出的内容，例如角色、记忆和对话记录
3. 下载备份文件
4. 在新环境导入备份文件
5. 检查角色、对话、记忆是否符合预期

如果你熟悉文件备份，也可以直接备份这些目录：

```text
data/
public/generated/
public/avatars/
public/attachments/
```

---

## 常见问题

<details>
<summary><strong>为什么打开后不能聊天？</strong></summary>

通常是模型接口没有配置好。请检查设置页中的 `API Base`、`API Key` 和 `Model` 是否正确，并确认你的模型服务支持 OpenAI Chat Completions API 格式。

</details>

<details>
<summary><strong>为什么模型列表拉取失败？</strong></summary>

有些服务商不提供模型列表接口，或者接口路径与 OpenAI 不完全一致。这种情况下可以手动填写模型名称。

</details>

<details>
<summary><strong>为什么 Docker 里访问不到本机的生图服务？</strong></summary>

容器里的 `127.0.0.1` 指容器自己，不是你的电脑宿主机。请改用宿主机局域网 IP，或在 Docker 网络中配置可访问的服务地址。

</details>

<details>
<summary><strong>为什么记忆没有立刻出现？</strong></summary>

记忆提取是后台任务，会在触发条件满足后执行。你可以检查记忆触发设置，也可以稍等片刻再刷新记忆管理页。

</details>

<details>
<summary><strong>为什么中文搜索有些结果和英文不一样？</strong></summary>

中文没有天然空格分词，项目对中文关键词做了包含搜索兼容，以减少漏搜。复杂关键词仍建议尝试更短的词。

</details>

<details>
<summary><strong>可以接入哪些模型？</strong></summary>

只要服务兼容 OpenAI Chat Completions API 格式，理论上都可以接入，例如 OpenAI、DeepSeek、各种中转服务、本地模型网关等。不同模型对图片、多模态、JSON 模式和上下文长度的支持会有差异。

</details>

---

## 项目结构

```text
LumiMuse/
├─ src/
│  ├─ app/                 # Next.js 页面与 API 路由
│  ├─ components/          # 聊天、侧边栏、搜索、记忆等界面组件
│  ├─ hooks/               # 前端自定义 Hook（可复用状态逻辑）
│  ├─ lib/                 # 数据库、AI 请求、记忆、时间、国际化等核心逻辑
│  └─ types/               # TypeScript 类型定义
├─ public/
│  ├─ avatars/             # 角色头像
│  ├─ generated/           # 生成图片
│  └─ attachments/         # 对话附件（图片 / 文本）
├─ data/                   # SQLite 数据库目录
├─ Dockerfile              # Docker 镜像构建配置
├─ docker-compose.yml      # Docker Compose 部署配置
└─ README.md
```

---

## 开发

如果你想修改代码，提交或部署前建议运行：

```bash
npm run lint
npm run build
```

---

<div align="center">

[MIT](LICENSE) © 2026 in30mn1a

</div>
