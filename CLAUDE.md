# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## 项目定位

这是一个 **Electron + React + TypeScript** 的本地优先日志应用。核心能力包括：

- 手动日志记录
- 麦克风录音与本地 Whisper 转写
- 本地浏览器历史采集与统计摘要
- SQLite 本地持久化
- JSON 备份导出 / 恢复
- 后台活动采集、开机自启、托盘驻留和自动摘要

## 技术栈

- Electron：桌面端容器和原生能力暴露
- React 19：界面层
- TypeScript：主语言
- Vite：renderer 构建
- Vitest：测试
- better-sqlite3：本地日志和浏览器历史读取
- @kutalia/whisper-node-addon：本地语音转写

## 目录结构

```text
apps/desktop
  electron/main.ts          Electron 主进程，负责 IPC、数据库、语音、备份
  electron/preload.ts       contextBridge 暴露 window.lifeLogger API
  src/App.tsx               React 页面和交互逻辑
  src/audio/recorder.ts     浏览器麦克风录音与 WAV 编码
  src/*.test.ts             单元测试
packages/domain            领域类型与 IPC 输入输出类型
packages/shared            日期和通用工具
packages/storage           SQLite LogRepository
packages/ai                Whisper 转写和浏览器历史摘要生成
packages/capture           本地浏览器历史采集
packages/capture/src/index.ts  浏览器历史与前台窗口采集
packages/sync              备份文件格式与解析
```

## 常用命令

```bash
npm install
npm run dev
npm run build
npm run typecheck
npm test
```

根目录脚本都委托给 `@life-logger/desktop` workspace。

## 关键设计决策

### 1. 本地优先，云同步可选

- SQLite 是唯一必需的数据源。
- 当前“同步”能力落地为 JSON 备份导出/导入，避免引入外部云依赖。
- 未来增加云同步时，应作为独立增量能力，不应破坏离线可用路径。

### 2. 输入方式多通道，统一日志模型

- 手动输入、语音转写、浏览器历史摘要都写入同一个 `LogEntry`。
- `sourceType` 使用 `manual`、`voice`、`ai_summary`、`activity_summary` 区分来源。

### 3. 浏览器历史采集与摘要解耦

- `packages/capture` 只负责从本机浏览器数据库读取原始历史。
- `packages/ai` 只负责将采集结果聚合为可读摘要。
- 主进程通过 IPC 串联两者，renderer 不直接接触历史数据库。

### 4. Electron 与 renderer 的边界

- renderer 通过 `window.lifeLogger` 访问主进程能力。
- IPC 输入输出类型统一放在 `packages/domain`。
- 文件系统、数据库、浏览器历史、对话框操作只在主进程进行。

### 5. 后台自动化

- `electron/activity-manager.ts` 负责活动会话、周期摘要、夜间摘要和登录项设置。
- `packages/capture/src/index.ts` 通过 PowerShell 读取 Windows 前台窗口。
- 活动只采集进程名和窗口标题，不采集键盘或截图。
- 关闭窗口默认隐藏到托盘，应用继续在后台运行。

## 代码规范

- TypeScript strict mode，未使用变量和未使用参数会报错。
- 使用 ES modules；Electron 主进程、preload 和后台线程由 esbuild 打包为 `dist-electron/*.cjs`，原生模块保持外部依赖。
- 路径别名 `@life-logger/*` 通过 tsconfig paths 和 Vite alias 解析。
- React 组件位于 `src/components`，`App.tsx` 负责导航、搜索与通知；界面 API 统一定义在 domain。

## 需要注意的运行时约束

- 语音转写依赖 `whisper-models/ggml-base.bin`，模型不存在时主进程会返回中文错误。
- 浏览器历史读取是只读操作，并会跳过被占用或不兼容的浏览器数据库。
- 备份恢复会覆盖当前所有日志，主进程会弹窗确认，并先保存安全副本。默认不自动清理原始活动。
- `better-sqlite3` 是原生模块，Electron 打包时需要注意 ABI 匹配。
