<div align="center">

<img src="public/icons/icon-192x192.png" alt="LumiMuse" width="96" height="96" />

# ✨ LumiMuse

**让 TA 慢慢填满你的房间。**

*A quiet, elegant AI companion — built for those who want something that feels real.*

<br/>

[![Next.js](https://img.shields.io/badge/Next.js_16-black?style=for-the-badge&logo=next.js)](https://nextjs.org)
[![React](https://img.shields.io/badge/React_19-61DAFB?style=for-the-badge&logo=react&logoColor=222)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind](https://img.shields.io/badge/Tailwind_v4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://www.sqlite.org)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-a78bfa?style=for-the-badge)](LICENSE)

<br/>

[English](README.en.md) · **中文**

<br/>

| 本地运行 | Docker 一键部署 | 数据自持有 |
|:---:|:---:|:---:|
| `npm run dev` | `docker compose up` | SQLite + 本地文件 |

</div>

---

## 目录

- [项目简介](#项目简介)
- [为什么要使用 LumiMuse？](#为什么要使用-lumimuse)
- [项目预览](#项目预览)
- [功能一览](#功能一览)
- [功能详情](#功能详情)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [首次使用指南](#首次使用指南)
- [Docker 部署](#docker-部署)
- [生图配置](#生图配置)
- [记忆系统](#记忆系统)
- [数据与隐私](#数据与隐私)
- [备份与迁移](#备份与迁移)
- [常见问题](#常见问题)
- [项目结构](#项目结构)
- [开发](#开发)

---

## 项目简介

LumiMuse 是一个轻量级 AI 角色扮演 / 陪伴系统，带长期记忆、现实时间注入、原生生图、数据导入导出和 Docker 部署支持。

它不是想做成一个什么都塞进去的巨型平台，而是更偏向一个「安静、好看、能长期用」的私人陪伴空间。

你可以创建角色，给 TA 性格、背景、开场白、示例对话和生图标签；也可以让 TA 在聊天中慢慢记住关于你、你们关系和共同经历的细节。数据全部留在本地或你自己的服务器。

---

## 为什么要使用 LumiMuse？

### 轻量化 RP，不需要复杂配置也能开始聊

有些 RP 工具很强，但也很重。

预设、世界书、插件、扩展、角色卡、聊天文件、数据库……第一次上手的时候经常像在调一个工程项目。

LumiMuse 的目标不是替代复杂玩法，而是提供一个更轻、更直觉的选择：

1. 创建角色
2. 填写人设
3. 配置模型接口
4. 开始聊天
5. 让记忆系统慢慢沉淀关系

如果你只是想和一个角色长期相处，而不是每天调半小时配置，LumiMuse 会比较适合。

### 自动记忆：TA 会慢慢记住你们之间的事

LumiMuse 内置长期记忆系统，不只是把聊天记录全塞回上下文。

它会在聊天过程中提取值得长期保留的信息，写入角色的记忆库，例如关系动态、话题历史、偏好习惯、人格特质和重要事件。

下次聊天时，系统会把相关记忆注入上下文，让角色更自然地「想起」过去发生过的事。

### 现实时间注入：角色知道现在是什么时候

LumiMuse 可以把现实时间注入聊天上下文。

角色可以知道现在是白天还是晚上，也能感受到时间经过。比如晚上聊天时自然地说晚安，隔几天回来时意识到你们已经有段时间没见。

对长期陪伴类 RP 来说，时间感很重要。  
有了时间感，角色才更像是在和你一起生活。

### 原生生图支持，不需要到处切工具

LumiMuse 内置 AI 生图功能，可以直接根据聊天内容或角色设定生成图片。

目前支持：

- Stable Diffusion WebUI
- NovelAI
- ComfyUI
- 自定义图片生成 API

你可以给角色保存外貌、服装、画风等生图标签。聊到某个场景时，可以顺手生成一张图看看。

### 多平台适配：电脑和手机都能用

LumiMuse 做了响应式布局。

桌面端适合长时间聊天、整理角色和记忆；移动端也做了适配，不是单纯把桌面页面硬塞到手机屏幕里。平板横竖屏、iOS 安全区域、字号与字体风格也都有考虑。

### 数据在你自己手里

角色、对话、记忆和生成图片都保存在你的本机或服务器。  
支持导入导出，方便备份和迁移；也支持 Docker 部署到自己的机器上。

---

## 项目预览

<table>
  <tr>
    <td align="center" width="50%">
      <img src="assets/首页.png" alt="首页" />
      <br/><sub>首页</sub>
    </td>
    <td align="center" width="50%">
      <img src="assets/对话.png" alt="对话" />
      <br/><sub>对话</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <img src="assets/编辑角色.png" alt="编辑角色" />
      <br/><sub>编辑角色</sub>
    </td>
    <td align="center" width="33%">
      <img src="assets/记忆管理.png" alt="记忆管理" />
      <br/><sub>记忆管理</sub>
    </td>
    <td align="center" width="33%">
      <img src="assets/设置.png" alt="设置" />
      <br/><sub>设置</sub>
    </td>
  </tr>
</table>

---

## 功能一览

| | 功能 | 说明 |
|:---:|:---|:---|
| 🎭 | **角色系统** | 独立性格、开场白、示例对话、生图标签；每角色独立对话与记忆，支持拖拽排序与 SillyTavern JSON 导入 |
| 💬 | **聊天体验** | 流式输出、编辑 / 删除 / 多版本重新生成、图片与文本附件、手动总结、现实时间注入 |
| 🧠 | **长期记忆** | 自动提取、AI 整理、画像、归档与索引；本地工作记忆 + 向量检索 + 重排 + token 预算装箱 |
| 🎨 | **AI 生图** | SD WebUI / NovelAI / ComfyUI / 自定义 API，版本历史与图片管理，支持自动生图关键词 |
| 🔌 | **多供应商** | 多套 API 配置一键切换，聊天输入框可临时切模型 |
| 🔍 | **搜索导航** | 全局消息搜索、日期搜索、中文包含搜索、结果定位高亮 |
| 📦 | **导入导出** | 角色 / 记忆 / 对话按需导出，支持轻量备份与完整迁移 |
| 🧹 | **维护面板** | 孤儿文件检测与清理；删除角色 / 对话时同步清理相关文件 |
| 📱 | **多端体验** | 响应式布局、iPad 横竖屏适配、iOS 安全区域、字号与字体风格设置 |
| 🔒 | **访问保护** | 可选访问密码、HMAC 签名 token、常量时间比较、SSRF 防护 |

---

## 功能详情

### 🎭 角色系统

- 创建、编辑、删除角色
- 可配置头像、性格、场景、开场白、示例对话与系统提示词
- 支持生图标签字段，角色画风、外貌与固定元素可随角色保存
- 每个角色拥有独立对话与记忆，适合维护不同关系线
- 侧边栏支持拖拽排序
- 支持导入 SillyTavern 风格角色卡 JSON（仅 JSON，不支持 PNG 内嵌格式）

### 💬 聊天体验

- 流式 / 非流式输出，支持停止生成
- 消息编辑、删除、重新生成与多版本切换；重新生成会保留旧版本
- 支持纯文本、图片附件与文本附件
- 图片附件以多模态内容进入上下文；文本附件拼入上下文
- 支持复制对话、按对话刷新消息
- 手动总结上下文，把较长历史压缩为 summary
- 现实时间注入：角色能感知当前时刻与时间流逝
- 顶栏展示最近对话，移动端工具栏默认展开，便于快速切换

### 🧠 长期记忆

- 从对话中提取长期记忆，按角色写入记忆库
- 分类包括关系动态、话题历史、基础信息、偏好习惯、人格特质与重要事件
- 支持按消息数、时间间隔、关键词三种触发方式，可独立开关
- 增强记忆引擎：本地工作记忆、memory profile（结构化角色画像）、embedding 向量索引与 reranker 重排
- 注入按 token 预算装箱（默认 `memory_package_token_budget = 12000`），优先保留高相关、高优先级记忆
- 记忆管理页支持分页、搜索、分类、排序、编辑、删除与标签管理
- 单个对话可忽略记忆提取，避免测试对话污染记忆库
- AI 整理可批量修正分类、重要度、情绪权重与标签，并自动重建相关索引
- AI 归档可将旧记忆压缩为摘要记忆，保留可追溯批次
- 记忆画像支持初始化、队列处理、手动编辑、版本切换与版本删除
- 后台任务可单独选择供应商与模型；使用 DeepSeek 时可关闭后台推理以降低整理 / 画像 / 归档耗时
- 设置页提供索引状态、重建、补索引、重试失败、停止任务与清空索引

### 🎨 AI 生图

- 支持 Stable Diffusion WebUI、NovelAI、ComfyUI、自定义 API
- 全局质量标签、负面提示词、尺寸、采样器、步数等常用参数
- 可根据聊天消息生成图片提示词，也支持自动生图关键词
- 图片版本历史：重新生成不会直接丢掉旧图
- 对话内预览、上一张 / 下一张切换、删除当前版本
- 角色图片管理支持批量删除与版本保留
- 生成中显示占位图与进度；失败时保留旧图

### 🔌 多供应商配置

- 设置页可保存多套 API 配置（不同服务商、模型、密钥）
- 聊天输入框可临时切换当前会话模型，方便对比效果
- 切换供应商不会改动已有消息历史

### 🔍 搜索与导航

- 全局搜索聊天消息，结果分页加载
- 中文关键词包含搜索，减少分词漏搜
- 日期搜索，例如 `2026年4月1日`、`2026/4/1`、`2026.4.1`
- 从搜索结果直接跳转并高亮定位原消息

### 📦 数据导入导出

- 导出角色、记忆、对话记录与消息
- 按需选择导出内容，支持轻量备份或完整迁移
- 导入备份文件，适合本地与服务器之间迁移
- 兼容 SillyTavern 风格角色卡 JSON 常用字段（仅 JSON；character book 等扩展字段不一定完整还原）
- 数据库使用 SQLite，默认保存在 `data/lumimuse.db`

### 🧹 维护面板

- 设置页可检测孤儿文件（不再被引用的头像、生成图、附件）
- 检测后可一键清理
- 删除角色或对话时同步清理对应图片与附件

### 📱 多端体验

- 响应式布局，兼顾桌面、平板与手机
- iPad / 平板横竖屏布局优化
- `h-dvh` 适配 iOS Safari 地址栏变化
- 处理 safe-area，避免输入框被系统手势区遮挡
- 触屏设备可点击显示 / 隐藏图片与消息操作按钮
- 设置页支持字体风格（霞鹜文楷 / 系统 / 衬线）与字号（小 / 中 / 大）全局缩放
- 明暗主题、中英双语界面

### 🔒 访问保护

- 通过 `ACCESS_PASSWORD` 设置访问密码；不设置时透明访问，适合本机使用
- 公网部署强烈建议设置访问密码
- 登录后下发 HMAC-SHA256 签名 token；可选 `AUTH_SECRET` 让 token 在多副本部署时通用
- 密码校验使用常量时间比较
- 默认不信任 `X-Forwarded-For`；仅在可信反向代理会覆盖转发头且应用端口不得绕过代理时设置 `TRUST_PROXY=1`
- 出站请求（生图、模型列表、总结、对话补全）经过 SSRF 防护
- 自部署本地 LLM / SD WebUI 时可设置 `ALLOW_LOCAL_NETWORK=1` 显式放开内网地址

---

## 技术栈

| 层级 | 技术 |
|:---:|:---|
| 应用框架 | Next.js 16（App Router，`output: "standalone"`） |
| 前端 | React 19 |
| 语言 | TypeScript（strict） |
| 样式 | Tailwind CSS v4 |
| 数据库 | SQLite + better-sqlite3（WAL） |
| AI 接入 | OpenAI Chat Completions 兼容格式 |
| 字体 | Quicksand + LXGW WenKai Screen（霞鹜文楷屏幕版） |
| 容器化 | Docker + Docker Compose |

---

## 快速开始

### 环境要求

- Node.js **>= 20.18.1**
- npm
- 兼容 OpenAI Chat Completions API 格式的模型服务
- Docker 部署还需 Docker 与 Docker Compose

CI 会在 Ubuntu（Node **20.18** / **24**）与 Windows（Node **20.18**）上验证；本地建议使用 Node 20.18.1 或更新版本。

### 本地开发

```bash
git clone https://github.com/in30mn1a/LumiMuse.git
cd LumiMuse
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)，进入设置页填写模型接口即可开始。

数据库会自动创建在 `data/lumimuse.db`。

### 本地生产启动

```bash
npm run build
npm run start:local
```

| 命令 | 说明 |
|:---|:---|
| `npm run start:local` | 使用 `next start`，适合在源码工作区检查生产构建 |
| `npm start` / `npm run start:standalone` | 运行 `.next/standalone/server.js`，与 Docker 镜像启动方式一致 |

### Windows 快速启动

项目根目录提供 `Start.bat`。已安装依赖后可双击启动。

---

## 首次使用指南

### 1️⃣ 配置模型接口

进入设置页，填写：

| 字段 | 说明 |
|:---|:---|
| `API Base` | 接口地址，例如 `https://api.openai.com/v1`，或中转 / 本地模型地址 |
| `API Key` | 模型服务密钥 |
| `Model` | 模型名称 |
| `Temperature` | 越高越发散，越低越稳定 |
| `Max Tokens` | 单次回复最多生成的 token 数 |
| `Context Window` | 模型大致可接收的上下文 token 上限 |

可尝试拉取模型列表；若服务商不支持，也可手动输入模型名。

### 2️⃣ 创建角色

建议至少填写：

- **名称** — 角色显示名
- **开场白** — 新对话的第一句话
- **性格 / 场景** — 稳定人设
- **系统提示词** — 更明确地告诉 AI 如何扮演
- **生图标签** — 若使用生图，建议写入外貌与画风

### 3️⃣ 开始对话

选择角色后即可创建对话：

- 发送文字
- 上传图片（需视觉模型）
- 上传文本附件作为上下文
- 对不满意的回复重新生成，并在版本间切换
- 长对话中手动总结上下文

### 4️⃣ 管理记忆

进入记忆管理页，定期检查并整理：

- 删除错误或不想保留的记忆
- 编辑描述不准确的记忆
- 添加标签，方便搜索
- 按分类或关键词筛选

---

## Docker 部署

### 1. 准备环境变量

```bash
cp .env.local.example .env.local
```

编辑 `.env.local`：

```env
# 访问密码（部署到公网时强烈建议设置）
ACCESS_PASSWORD=your_password_here

# 可选：HMAC token 签名密钥（默认从 ACCESS_PASSWORD 派生）
# 多副本部署或希望 cookie 跨重启不失效时建议显式设置
# AUTH_SECRET=use_a_long_random_string_here

# 可选：仅在可信反向代理覆盖 X-Forwarded-For 时启用
# TRUST_PROXY=1

# 可选：多级代理时设置可信 hop 数（默认 1）
# TRUST_PROXY_HOPS=2

# 可选：自部署本地 LLM / SD WebUI 时显式允许内网地址
# ALLOW_LOCAL_NETWORK=1
```

> ⚠️ 不设置 `ACCESS_PASSWORD` 时不会要求登录，只建议本机或可信局域网使用。生产 Docker 启动会 fail-fast 拒绝空密码或 `your_password_here` 这类占位值。

`docker-compose.yml` 默认通过 `env_file` 读取 `.env.local`。若使用其他文件：

```bash
LUMIMUSE_ENV_FILE=.env.production docker compose up -d --build
```

### 2. 启动服务

```bash
docker compose up -d --build
```

启动后打开 [http://localhost:3000](http://localhost:3000)

### 3. 持久化数据

| 宿主机目录 | 容器目录 | 用途 |
|:---|:---|:---|
| `./data` | `/app/data` | SQLite 数据库 |
| `./public/generated` | `/app/public/generated` | 生成图片 |
| `./public/avatars` | `/app/public/avatars` | 角色头像 |
| `./public/attachments` | `/app/public/attachments` | 对话附件 |

容器以非 root 用户 **UID/GID 1001** 启动。Linux bind mount 时请先执行：

```bash
sudo chown -R 1001:1001 data public/generated public/avatars public/attachments
```

Windows / macOS 的 Docker Desktop 通常无需手动改权限。

### 4. 更新版本

```bash
git pull
docker compose up -d --build
```

更新前建议先导出备份，或手动备份 `data/` 与 `public/{generated,avatars,attachments}/`。

**健康检查**

| 端点 | 含义 |
|:---|:---|
| `/api/health` | 进程存活 |
| `/api/health?ready=1` | 存活 + SQLite 与四个持久化目录可写 |

CI 镜像会把完整 commit SHA 写入健康响应的 `build` 字段；本地 Compose 默认 `local`。自建镜像可设置 `LUMIMUSE_BUILD_SHA=$(git rev-parse HEAD)`。

若容器反复不就绪，先看 `docker compose logs lumimuse`，再检查 UID/GID 1001 权限、磁盘空间与挂载目录。

---

## 生图配置

进入设置页开启生图功能后，可选择不同引擎。

### Stable Diffusion WebUI

- 默认地址：`http://127.0.0.1:7860`
- 需要 WebUI 开启 API
- 可设置模型、采样器、步数、CFG Scale、宽高与负面提示词

> ⚠️ LumiMuse 在 Docker 中、SD WebUI 在宿主机时，`127.0.0.1` 指向容器内部。请改用宿主机局域网 IP。

### NovelAI

- 需要 NovelAI API Key
- 可配置模型、采样器、噪声调度、步数、scale、尺寸、负面提示词与 artist tags

### ComfyUI

- 默认地址：`http://127.0.0.1:8188`
- 需要填写工作流 JSON
- 请确保提示词与输出节点与项目预期兼容

### 自定义 API

- 适合 OpenAI DALL·E 格式或其他兼容接口
- 填写接口地址、可选 API Key、模型名与图片尺寸

---

## 记忆系统

LumiMuse 的记忆不是简单把所有聊天塞回上下文，而是：

```text
提取 → 管理 / 整理 / 归档 → 检索 → 装箱注入
```

1. **提取** — 触发条件满足后，后台任务从对话中总结值得长期保留的内容
2. **管理** — 记忆进入角色记忆库，可手动编辑、删除、打标签；也可 AI 整理 / 归档
3. **检索** — 结合优先级、关键词、可选向量检索与重排，选出相关记忆
4. **注入** — 按 token 预算装箱后放入 system prompt，让角色「想起」这些内容

**可配置项包括：**

- 是否启用记忆注入
- 按消息数 / 时间 / 关键词触发提取
- 增强记忆引擎开关与检索相关参数
- `memory_package_token_budget`：每次聊天注入记忆包的 token 预算（默认 12000）
- 后台模型与推理强度
- 单个对话是否忽略提取

若某次对话只是测试模型或调提示词，可设为忽略记忆，避免污染记忆库。

> 设计理念：**无限存储，有限激活**。底层记忆可长期增长；每轮只注入相关、排序后的一组。

---

## 数据与隐私

核心数据保存在你自己的本机或服务器：

| 路径 | 内容 |
|:---|:---|
| `data/lumimuse.db` | SQLite 数据库 |
| `public/generated/` | 生成图片 |
| `public/avatars/` | 角色头像 |
| `public/attachments/` | 对话附件 |

应用本身不会把角色、对话或记忆上传到 LumiMuse 作者服务器。实际外发请求主要来自你配置的模型接口与生图接口。

公网部署时请务必：

- 设置 `ACCESS_PASSWORD`（不要用空值或示例占位值）
- 使用 HTTPS，建议放在反向代理后面
- 仅在可信代理覆盖转发头时设置 `TRUST_PROXY=1`
- 定期备份 `data/` 与 `public/{generated,avatars,attachments}/`
- 不要把 `.env.local`、数据库或个人备份提交到公开仓库

---

## 备份与迁移

**推荐：应用内导出 / 导入**

1. 在旧环境选择需要导出的内容（角色、记忆、对话等）
2. 下载备份文件
3. 在新环境导入
4. 检查角色、对话、记忆是否符合预期

**也可以直接备份目录：**

```text
data/
public/generated/
public/avatars/
public/attachments/
```

数据库迁移会写入 SQLite `user_version`。降级到旧版前必须先停止应用并完整备份上述目录。不要靠手工降低 `user_version` 回滚；应恢复与旧版匹配的整份数据库和文件备份。

---

## 常见问题

<details>
<summary><strong>为什么打开后不能聊天？</strong></summary>

<br/>

通常是模型接口没有配置好。请检查设置页中的 `API Base`、`API Key` 和 `Model`，并确认服务支持 OpenAI Chat Completions API 格式。

</details>

<details>
<summary><strong>为什么模型列表拉取失败？</strong></summary>

<br/>

有些服务商不提供模型列表接口，或路径与 OpenAI 不完全一致。可手动填写模型名称。

</details>

<details>
<summary><strong>为什么 Docker 里访问不到本机的生图服务？</strong></summary>

<br/>

容器里的 `127.0.0.1` 指容器自己，不是宿主机。请改用宿主机局域网 IP，或配置 Docker 网络中可访问的地址。需要访问内网服务时，设置 `ALLOW_LOCAL_NETWORK=1`。

</details>

<details>
<summary><strong>为什么记忆没有立刻出现？</strong></summary>

<br/>

记忆提取是后台任务，会在触发条件满足后执行。可检查触发设置，或稍后再刷新记忆管理页。

</details>

<details>
<summary><strong>为什么中文搜索有些结果和英文不一样？</strong></summary>

<br/>

中文没有天然空格分词，项目对中文关键词做了包含搜索兼容。复杂关键词建议尝试更短的词。

</details>

<details>
<summary><strong>可以接入哪些模型？</strong></summary>

<br/>

只要服务兼容 OpenAI Chat Completions API 格式，理论上都可以接入，例如 OpenAI、DeepSeek、各类中转服务、本地模型网关等。不同模型对图片、多模态、JSON 模式和上下文长度的支持会有差异。

</details>

<details>
<summary><strong>字号 / 字体在哪里改？</strong></summary>

<br/>

设置页可切换字体风格（霞鹜文楷 / 系统 / 衬线）与字号（小 / 中 / 大）。字号通过根元素 `font-size` 缩放全局 rem 体系。

</details>

---

## 项目结构

```text
LumiMuse/
├─ src/
│  ├─ app/                 # 页面与 API 路由（App Router）
│  ├─ components/          # 聊天、侧边栏、搜索、记忆、设置等 UI
│  ├─ hooks/               # 前端自定义 Hook
│  ├─ lib/                 # 数据库、AI 请求、记忆、鉴权、国际化等核心逻辑
│  └─ types/               # TypeScript 类型定义
├─ public/
│  ├─ avatars/             # 角色头像
│  ├─ generated/           # 生成图片
│  └─ attachments/         # 对话附件
├─ data/                   # SQLite 数据库目录
├─ assets/                 # README 预览图
├─ tests/                  # Node 测试（.cjs）
├─ Dockerfile
├─ docker-compose.yml
├─ Start.bat               # Windows 本地快捷启动
├─ README.md
└─ README.en.md
```

---

## 开发

`Start.bat` 是 Windows 本地开发快捷入口，不是生产服务管理器。

提交或部署前请跑与 CI 一致的验证序列：

```bash
npm run lint
npm test
npm run regression
npm run build
```

`package.json` 中针对 Next.js 的 PostCSS override 是有意的安全覆盖：它只替换 Next 的传递依赖，直到上游版本自带同等或更新修复。升级 Next 后可用 `npm explain postcss` 检查依赖树，并用 `npm prune --dry-run` 验证不会产生额外清理。

---

<div align="center">

<br/>

**LumiMuse** — 让 TA 慢慢填满你的房间。

<br/>

[MIT](LICENSE) © 2026 [in30mn1a](https://github.com/in30mn1a)

</div>
