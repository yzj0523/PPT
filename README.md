# AI Writing Assistant

一个受 NotebookLM 启发的 AI 写作助手。

## 项目概述

用户可以导入写作素材、引用知识库，借助 AI 对内容进行分析，并生成演讲文稿、通用文稿、思维导图等多种产出。

当前仓库提供了一个已实现部分功能的前端原型（`index.html`），可直接在浏览器中打开预览。

## 面试任务

`index.html` 仅作为产品原型供参考，你需要自己新增代码来实现完整功能，**不要改动该文件**。

请完成以下工作：

1. **功能分析** —— 阅读原型代码，理解各模块的职责与交互逻辑。
2. **问题诊断** —— 找出当前原型中存在的问题或不合理之处。
3. **功能实现** —— 根据界面布局与交互，推断并补全尚未完成的功能，让产品真正可用。
   - **提示**：PPT 生成等 AI 生成功能请通过 Skill 机制来组织，便于维护和扩展。

技术栈不限。请实现完整功能，无需考虑用户登录。面试时将进行 Code Review。

## 运行写作工作台

使用 Node.js 24 LTS。在 Windows PowerShell 中运行以下命令，然后打开 `http://127.0.0.1:5173/`。

```powershell
npm.cmd ci
npm.cmd run dev
```

构建后的入口由 Fastify 同时提供网页和 API。停止开发服务后，运行 `npm.cmd run build` 和 `npm.cmd start`，然后打开 `http://127.0.0.1:4173/`。服务默认只监听 `127.0.0.1`。SQLite 默认文件是 `data/workspace.sqlite`。可以用 `WORKBENCH_DB_PATH` 指定其他数据库文件。

### 配置模型

在项目根目录参照 `.env.example` 创建 `.env.local`，填写兼容 Chat Completions 的服务地址、模型和密钥。地址应是服务的 API 根地址，例如 `https://your-provider.example/v1`。服务将追加 `/chat/completions`。开发、生产启动和真实模型验收都会读取 `.env.local`。该文件已加入 Git 忽略规则。

也可以在准备启动服务的终端设置以下环境变量。终端中已设置的值优先。

```powershell
$env:AI_BASE_URL = 'https://your-provider.example/v1'
$env:AI_MODEL = 'your-model-name'
$env:AI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host '模型密钥' -AsSecureString)).Password
```

未配置模型时，工作台仍可启动、导入文件和管理来源。配置后的状态会在工作台顶部显示。首次体验可在「选择知识库」中选中「写作素材示例」，使用其中的演示材料试跑摘要、问答或生成；上传时勾选「纳入知识库」会将成功解析的文档加入「我的素材库」。下载的产物为独立 HTML。

重复保存同一份摘要会复用记录。重试生成使用原任务的来源快照与要求，并创建一条新记录。已完成和失败的记录可以删除。同一文档从多个库选中时，引用展示本次选择中的第一个归属库。

### 验证

```powershell
npm.cmd test
npx.cmd playwright install chromium
npm.cmd run test:e2e
npm.cmd run build
```

浏览器测试会启动开发服务和构建版本，并使用本地模型替身。配置真实模型后，运行 `npm.cmd run test:live`。该命令使用合成 PDF、DOCX 和示例知识库，验证可追溯的摘要、两轮问答、短篇 PPT、通用写作、通知占位、导图和摘要的 HTML 导出。真实模型结果还应人工核对事实、表达和版式。

当前的可配置阈值包括 DOCX 解包体积 `WORKBENCH_DOCX_MAX_UNPACKED_BYTES`（默认 64 MiB）、来源正文预算 `WORKBENCH_CONTEXT_CHARACTERS`（默认 20,000 字符）、脑图深度 `WORKBENCH_MAP_MAX_DEPTH`（默认 6）、脑图节点数 `WORKBENCH_MAP_MAX_NODES`（默认 120）和生成任务超时 `WORKBENCH_JOB_TIMEOUT_MS`（默认 90 秒，模型调用有独立的 60 秒上限）。

多批上传共享同一服务的 `WORKBENCH_SOURCE_STAGING_BYTES` 暂存上限，默认 128 MiB。暂存不足会逐项返回可重试错误。通知的具体正文采用来源或用户要求中的可核对摘录，发文单位和日期由已验证字段或占位符渲染。

面试原型仍可直接在浏览器中打开。使用 `Get-FileHash -Algorithm SHA256 -LiteralPath .\index.html` 核对原型文件，基线为 `2E0709FE26D950EE20C4E19F3FECDFCD87A0AC1484E08C75ADBA2AF1F623C7CF`。
