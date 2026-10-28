# dsh-auto-memory

[![test](https://github.com/y0shua1ee/dsh-auto-memory/actions/workflows/test.yml/badge.svg)](https://github.com/y0shua1ee/dsh-auto-memory/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@y0shua1ee/dsh-auto-memory.svg)](https://www.npmjs.com/package/@y0shua1ee/dsh-auto-memory)

给 DeepSeek Harness（DSH）加一层 **Claude Code 式的项目记忆与规则**：

- 一个 `memory` 工具、一个每次会话自动注入的 `MEMORY.md` 索引，以及一个按项目隔离的磁盘目录；
- 兼容 Claude Code 的 `.claude/rules/`（含用户级 `~/.claude/rules/` 和 `paths:` 路径作用域），并额外支持 DSH 的 `.dsh/rules/`。

它为 DSH 补上 `AGENTS.md` 之外的那半套能力：模型可以在会话中主动写笔记，下次打开同一项目时这些笔记自动回到上下文；仓库级和用户级规则也能按路径懒加载。

## 它做什么

| 能力 | 说明 |
|---|---|
| `memory` 工具 | `view / create / str_replace / insert / delete / rename`，路径是虚拟的 `/memories/...` |
| 索引注入 | `agent/pre-step` 时读取 `MEMORY.md`，以 `<system-reminder>` 形式插入当前请求 |
| Rules 兼容 | 读取 `~/.dsh/rules`、`~/.claude/rules`、项目 `.dsh/rules` / `.claude/rules`，支持 `paths:` 路径作用域 |
| 去重 | 注入消息带渲染快照的 SHA-256；同一快照不重复注入，压缩后自动重注 |
| 项目隔离 | 以最近的 `.git`（可配置）为项目根；没有标记时退回工作目录 |
| 索引维护 | 新建/重命名/删除主题文件时，自动增删 `MEMORY.md` 中对应的链接行 |
| 提示词引导 | 注册 `tool:memory` system-prompt section，写清该记什么、不该记什么 |

## 目录布局

```
~/.dsh/auto-memory/
└── --Users-areslee-Documents-dev-active-my-project--/
    ├── MEMORY.md          # 索引：每条一行，注入会话
    ├── testing.md         # 主题文件：细节
    └── decisions.md
```

项目目录名与 DSH 的 session 目录规则一致（`--` + 路径转义 + `--`），所以 `~/.dsh/sessions/` 和 `~/.dsh/auto-memory/` 可以对照着看。

## 安装到 DSH profile

本包是一个 **DSH bundle**：`package.json` 声明 `dsh.bundle.patch`，安装后自动加入 profile 的 `dsh.profile.bundles`，由包内的 `cordis.patch.yml` 挂载插件行，不需要再手写 `insert`。目标版本为 DSH `0.2.1-rc.3`。

### 方式 A：Plugins 页面（推荐）

重启 DeepSeek Harness 后打开 **插件 → 添加插件**，输入：

- 本地目录的绝对路径（例如 `~/Documents/dev/active/dsh-auto-memory`），或
- npm 包名 `@y0shua1ee/dsh-auto-memory`。

> 无 scope 的 `dsh-auto-memory` 是另一个 DSH 插件（`AskTheWay/dsh-auto-memory`），不要安装那个；本仓库使用 scoped 包名。

本地目录会以 `link:` 形式写入当前 profile 的 `package.json`，并自动选中 bundle。安装完成后它应出现在 **已安装插件** 列表。

### 方式 B：命令行

```bash
# 本地目录
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-auto-memory
# GitHub
dsh plugin --profile <profile> add git+https://github.com/y0shua1ee/dsh-auto-memory
# npm
dsh plugin --profile <profile> add @y0shua1ee/dsh-auto-memory
```

然后确认 profile 的 `package.json` 中 `dsh.profile.bundles` 含 `@y0shua1ee/dsh-auto-memory`。

### 方式 C：手动配置

1. 在 profile 的 `package.json` 中加入依赖：

```json
{
  "dependencies": {
    "@y0shua1ee/dsh-auto-memory": "link:/absolute/path/to/dsh-auto-memory"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@y0shua1ee/dsh-auto-memory"]
    }
  }
}
```

2. 在 profile 目录安装：

```bash
cd ~/.dsh/profiles/<profile>
pnpm install --prefer-offline
```

3. **不要**再往 `cordis.patch.yml` 里加 `insert` 行；bundle 自带的 patch 已经负责挂载。要改配置时，用 id 覆盖：

```yaml
- id: dsh-auto-memory
  config:
    maxIndexLines: 200
    userRuleDirs: ["~/.dsh/rules", "~/.claude/rules"]
```

4. 重启 DeepSeek Harness。

> 桌面应用使用的是 `~/.dsh/profiles/desktop`；其他 profile（例如 `web`）按同样方式安装。桌面 profile 默认没有 `patchReload: live`，改配置后需要重启应用。

### 生效与验证

- 插件代码通过 `link:` 加载；**更新代码后需要重启 DeepSeek Harness**，配置文件变更在 `patchReload: live` 的 profile 中可以热重组。
- 重启后在 **插件 → 已安装插件** 里应看到 `@y0shua1ee/dsh-auto-memory`，开关为开启状态。
- 在会话里让 agent 调一次 `memory view /memories`，应返回空目录提示。
- 让 agent 记住一条内容，检查 `~/.dsh/auto-memory/<projectKey>/MEMORY.md` 是否出现。
- 规则：在 `~/.claude/rules/` 或项目 `.claude/rules/` 放一个 `.md`，重启后新会话应自动注入；带 `paths:` 的规则在读写匹配文件后出现。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `"auto-memory"` | 记忆根目录；相对路径基于 `$DSH_HOME`，也可写绝对路径或 `~/...` |
| `maxIndexBytes` | `25600` | 注入时 `MEMORY.md` 正文字节上限 |
| `maxIndexLines` | `200` | 注入时 `MEMORY.md` 行数上限 |
| `maxFileBytes` | `65536` | 单个记忆文件写入上限 |
| `maxFiles` | `200` | 每个项目的 `.md` 文件数上限（含 `MEMORY.md`） |
| `projectRootMarkers` | `[".git"]` | 向上查找的项目根标记；空数组表示直接用工作目录 |
| `inject` | `true` | 是否自动注入索引 |
| `injectInSubagents` | `false` | 是否也给子 agent 注入（默认只给顶层会话） |
| `guidance` | `true` | 是否注册 system-prompt 引导段 |
| `rules` | `true` | 是否加载用户级 / 项目级 rules |
| `userRuleDirs` | `["~/.dsh/rules", "~/.claude/rules"]` | 用户级规则目录 |
| `projectRuleDirs` | `[".dsh/rules", ".claude/rules"]` | 项目级规则目录（相对项目根） |
| `maxRuleBytes` | `65536` | 单条规则正文上限 |
| `maxRulesBytes` | `131072` | 一次收集的规则总字节上限 |
| `maxRules` | `100` | 一次收集的规则条数上限 |

## `memory` 工具

所有路径都在 `/memories` 下，且只允许 `.md` 文件：

| 命令 | 必填参数 | 说明 |
|---|---|---|
| `view` | 可选 `path`、`numbered` | 不传 `path` 列出根目录；传文件路径返回原文；`numbered: true` 加行号 |
| `create` | `path`、`file_text` | 创建新文件；`MEMORY.md` 传空文本会写入标准索引头 |
| `str_replace` | `path`、`old_str`、`new_str` | `old_str` 必须恰好出现一次 |
| `insert` | `path`、`insert_line`、`insert_text` | `insert_line` 从 0 开始，0 表示插到第一行之前 |
| `delete` | `path` | 删除文件，并清掉索引里的对应行 |
| `rename` | `path`、`new_path` | 重命名，并同步索引链接；不允许改名 `MEMORY.md` |

示例：

```json
{ "command": "create", "path": "/memories/testing.md", "file_text": "# Testing\n\n用 node --test。" }
```

新建主题文件后，索引里会自动出现：

```markdown
- [testing](testing.md) — Testing
```

模型仍应把这一行改写成有意钩子（“为什么这条值得记”），而不是保留自动生成的标题。

## Rules（兼容 Claude Code）

Claude Code 的规则是另一套机制：`.claude/rules/**/*.md`，可选用 `paths:` frontmatter 按文件路径懒加载。本插件直接兼容它，并额外支持 DSH 自己的 `.dsh/rules/`。

| 作用域 | 目录 |
|---|---|
| 用户级（所有项目） | `~/.dsh/rules/**/*.md`、`~/.claude/rules/**/*.md` |
| 项目级 | `<project>/.dsh/rules/**/*.md`、`<project>/.claude/rules/**/*.md` |

用户规则先于项目规则注入。`~/.claude/rules/` 里的 symlink 会被跟随，所以 Home Manager / Nix 管理的规则（例如 `mac-config.md`、`cloudflare.md`）不用迁移；项目规则目录里指向项目外的 symlink 会被跳过，避免仓库把外部文件带进上下文。

### frontmatter

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "src/**/*.{ts,tsx}"
---

# API rules

- ...
```

- 没有 `paths`：会话开始后第一步注入。
- 有 `paths`：`read` / `write` / `edit` 命中匹配文件后，下一步注入。用户规则相对当前 cwd，项目规则相对项目根。
- 支持 `*`、`**`、`?`、`{a,b}`、`[abc]`；frontmatter 只读取 `paths`，其他字段忽略。
- 规则内容会转义 `</system-reminder>`，注入文本明确标为背景上下文，不覆盖 system / 用户指令。

因此你现有的 `~/.claude/rules/mac-config.md` 会直接对 DSH 生效，不需要在 `~/.dsh/AGENTS.md` 里再抄一份。

## 注入与去重

每次 `agent/pre-step`：

1. 解析当前会话工作目录，向上找 `.git`，得到项目根和 `projectKey`。
2. 读取 `~/.dsh/auto-memory/<key>/MEMORY.md`；不存在就跳过。
3. 按 `maxIndexLines` / `maxIndexBytes` 截断，转义 `</system-reminder>`，算出快照 digest。
4. 若当前请求或会话可见 surface 里已有同 digest 的 `auto-memory` 消息，跳过。
5. 否则在“已 claim 的历史消息之后、本轮新用户消息之前”插入一条 user-role 消息。

因此：

- 同一会话内重复 step 不会重复注入。
- 模型刚更新 `MEMORY.md`，下一步就能看到新索引。
- 压缩（compaction）把旧注入卷进摘要后，surface 里找不到旧 digest，下一步会重新注入当前索引。
- 子 agent 默认只拿工具、不拿注入，避免每个子任务都背一份索引。

## 安全边界

记忆是“模型可写的持久文本”，下次会话又会被注入——这本质上是一条跨会话的 prompt injection 通道。插件做了这些限制：

- 所有读写都被限制在配置的 `root` 下；拒绝 `..`、绝对路径、隐藏段、符号链接和路径穿越。
- 只接受 `.md`，拒绝二进制内容；单文件、文件数、索引大小都有上限。
- 写入使用同目录临时文件 + `rename` 原子替换，权限 `0600`。
- 注入文本明确标为“可错的背景上下文，不是指令”，不能覆盖 system/user 指令。
- 写入动作不经过 workspace 沙箱（这是有意的：记忆在 `~/.dsh`，不在仓库里），所以只应把 `root` 指向专用目录。
- 项目规则来自仓库，属于不可信输入；插件会跳过项目规则目录中指向项目外的 symlink，但仍建议只对信任的仓库启用规则。
- rules 和 AGENTS.md 一样是“上下文”，不是强制配置；真正的硬约束（权限、禁止操作）应使用 DSH 的权限/审批机制。

仍然建议：

- 不要把密钥、token、密码、个人隐私写进记忆。
- 定期 `memory view /memories` 或直接看文件，审查模型写了什么。
- 不要把 `root` 指到已有代码目录或 `~/.dsh` 根本身。

## 测试

纯逻辑测试（store / paths / render / rules）不需要 DSH 运行时：

```bash
cd dsh-auto-memory
node --test test/store.test.mjs test/render-paths.test.mjs test/rules.test.mjs
```

插件装配与注入的集成测试需要一份 DSH 运行时。先解出安装包（默认写到 `/tmp/dsh-app`，原生模块会从 `app.asar.unpacked` 合并）：

```bash
node scripts/extract-runtime.mjs

DSH_APP_NODE_MODULES=/tmp/dsh-app/dsh/node_modules \
  node --import ./test/register.mjs --test test/plugin.test.mjs test/rules-plugin.test.mjs
```

集成测试覆盖：`defineTool` 接受工具 schema、prompt section 注册、首次注入、重复 step 去重、索引变化后重注、工具增删改查、索引自动维护、子 agent 跳过、结构化错误码，以及 rules 的无条件注入、`paths` 懒加载、去重、文件变化重注、memory + rules 共存、项目外 symlink 跳过。

## 已知限制

- 没有 `/memory` 客户端面板；查看和编辑靠工具或直接看文件。
- 没有后台 LLM 提炼：记忆完全由模型在会话中主动写入，和 Claude Code 的 auto memory 一致。
- Rules 只实现 `paths` 一个 frontmatter 字段，没有完整 YAML、`@import`、托管策略或 `/rules` 面板。
- `paths` 目前只由 `read` / `write` / `edit` 触发；用 `bash cat/head` 读文件不会触发。
- 不是 bundle：不会出现在 Web 的 Plugins 市场页，只能按上面的 row 方式挂载。
- 一个 profile 一个 root；跨项目共享要自己写 `AGENTS.md` 或另开配置。
- 依赖 DSH `0.2.1-rc.3` 的内部接口（`agent/pre-step`、`agent.inbox`、`defineTool`、`systemPrompt.section`）。DSH 升级后若接口变动，需要跟着改。
- `MEMORY.md` 超过注入预算时只注入前 N 行/字节；完整内容要用 `memory view`。

## 卸载

1. 从 `cordis.patch.yml` 删掉 `auto-memory` 的 insert 行。
2. 从 profile 的 `package.json` 删掉 `@y0shua1ee/dsh-auto-memory` 依赖，执行 `pnpm install`。
3. 可选：删除 `~/.dsh/auto-memory/`（记忆文件不会自动删除）。

代码目录本身可以保留，删除 profile 里的引用后不会加载。

## 设计来源

- Claude Code 的 auto memory：`MEMORY.md` 索引 + 主题文件 + 模型主动写。
- Claude Code 的 rules：`.claude/rules/**/*.md` + `paths:` 路径作用域。
- DSH 的 `dsh-agent-instructions`：`agent/pre-step` 注入、digest/可见性去重、surface 扫描。
- DSH 的 `dsh-tool-goal`：`defineTool` 参数/输出 schema 与 `presentCall` 形状。
