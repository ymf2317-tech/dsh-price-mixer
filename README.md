# dsh-price-mixer

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 [dsh-context](https://github.com/bowenliang123/dsh-context) 成本估算**补上自定义模型的价格**，并提供一个侧栏面板让你随时改价。

A DSH plugin that injects custom per-model prices into the models.dev price book that `dsh-context` fetches, so locally proxied models — self-hosted gateways, OpenAI-compatible reverse proxies, models missing from models.dev — finally show an **Est. Cost** in the Context panel instead of `—`. Ships a sidebar panel to edit the shadow prices.

---

## 它解决什么问题

dsh-context 的 Est. Cost = token 数 × 单价，单价来自 [models.dev](https://models.dev) 的公开价格簿。这条链路有两个硬伤，跑自建网关的人一定碰到：

1. **provider 不在簿子上就永远无价。** 你自建的 provider（例如 `agent2api`）在 models.dev 的 235 个 provider 里查不到 → dsh-context 直接判定 `Not priced`。
2. **同名模型无法唯一归属。** 就算模型名对上了（`glm-5.3`、`deepseek-v4.1-flash`），同一个名字挂着三十几家厂商、报价各不相同，dsh-context 只能标成 ambiguous。

结果是：你明明在烧 token，面板却告诉你**成本 `—`**。花钱的工具反而最看不到钱。

这个插件在**不改 dsh-context 任何文件、不起任何服务、不占任何端口**的前提下把价格缝进去，并且提供了一个侧栏面板用来手填/覆盖单价。

## 它怎么做的

宿主启动时给 `globalThis.fetch` 套一层壳，**只认一个 URL**：`https://models.dev/api.json`。

```
dsh-context ──fetch(api.json)──▶ [壳] ──fetch──▶ models.dev   拉真价格簿
                                  │
                                  ├─ 内存里注入 provider "agent2api" 价格段
                                  ▼
                          dsh-context 收到「权威价格簿 + 我方私货」
```

- 其它任何请求原样放行；
- 注入路径任何一步抛错都**回退成重拉原书透传** → 最坏结果是"没有自定义价"，绝不会弄坏价格簿；
- 权威源照常走，上游调价自动跟随（自动派生部分不写死数值）；
- dsh-context 缓存价格簿的 1 小时 TTL 不受影响。

## 价格解析顺序

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | **手填** | 面板保存，存在 `~/.dsh/price-mixer.json`；永远最优先 |
| 2 | **派生** | 模型名剥掉 `-max` 后查内置映射表，**抄权威簿里对应厂商条目的当前价**（含 cache_read），上游调价自动跟随 |
| 3 | **模糊匹配** | ①同厂商家族内"末段同名"（`glm-*`→`zhipuai`、`kimi-*`→`moonshotai` 等）；②全库同名且**所有列出该名字的厂商报价一致**才采用，不一致就留空不猜 |
| 4 | 无源 | 不注入，面板显示"无价"，等你手填 |

内置映射表覆盖 19 条常见自建命名，例如 `glm-5.3-max`→`zhipuai/glm-5.3`、`deepseek-v4.1-flash-max`→`deepseek/deepseek-v4-flash`、`Doubao-Seed-2.1-Pro-max`→`ofox/volcengine/doubao-seed-2.1-pro`、`minimax-m3.1-flash-max`→`novita-ai/minimax/minimax-m3.1-flash`。

## 侧栏面板

侧栏「价格影子」图标 → 打开后列出全部模型：

- 每行：模型 id + 来源标签（**手填 / 派生 / 模糊 / 无价**）+ 派生来源
- 四个输入框：输入 / 输出 / 缓存读 / 缓存写（USD per 1M tokens）
- 按钮：**保存**（写手填价）、**恢复派生**（删手填、回落派生）、**刷新**、**重读价格簿**、**清空手填**

价格簿由插件自己按需拉取（后台进行、1 小时缓存、60s 超时、失败保留上次结果），**不依赖 dsh-context 先取过一次**；面板打开时会自动轮询到就绪。

![上下文洞察面板：接入后 Est. Cost 出数](docs/context-panel-today.jpg)

## 依赖

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| **DeepSeek Harness** | `>= 0.2.0-rc.2`（实测 0.2.2-rc.1） | 插件宿主；用到 `webServer` 服务与 `slots` 客户端插槽 |
| **Node.js** | `>= 22.19.0`（实测 24.9.0） | 宿主运行时；用到全局 `fetch` / `Response` / `AbortSignal.timeout` |
| **dsh-context** | 任意版本（实测 0.83.1） | **被增强方**，不是硬依赖：没装它插件也能跑，只是没有 Est. Cost 可看 |
| **@deepseek-ai/dsh-client-ui-slots** | 随 DSH 提供 | 客户端插槽（`sidebar.panellist` / `main`） |
| 网络 | 需要能访问 `https://models.dev/api.json` | 约 6 MB；拉不到时插件退化为"只用上次结果 + 手填" |

**不依赖**：任何外部服务、端口、数据库、Python、Docker。插件没有 npm 运行时依赖（只有 `node:fs` / `node:os` / `node:path`）。

## 安装

DSH 的 profile 目录（默认 `~/.dsh/profiles/web`）下有两种装法。

### 方式 A：从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:ymf2317-tech/dsh-price-mixer
```

### 方式 B：本地 vendor 目录（不想让它自动更新时）

```bash
# 1. 放到 profile 的 vendor 下
cd ~/.dsh/profiles/web
git clone https://github.com/ymf2317-tech/dsh-price-mixer vendor/dsh-price-mixer

# 2. 在 package.json 的 dependencies 里加一行
#    "dsh-price-mixer": "file:vendor/dsh-price-mixer"
#    并在 dsh.profile.bundles 数组里加 "dsh-price-mixer"
pnpm install
```

> ⚠️ 必须是 `file:vendor/...` 形式并登记到 `dsh.profile.bundles`，否则下次 `dsh plugin install` 会把 vendor 里的东西 prune 掉。
> ⚠️ `file:` 依赖在 `node_modules` 里是**复制**不是软链：改了 vendor 侧 `package.json` 后要 `rm -rf node_modules/dsh-price-mixer && pnpm install` 才会刷新。

安装后**重启 dsh**，浏览器再 `Ctrl+Shift+R`。验证：

```bash
curl -s http://127.0.0.1:<web端口>/price-mixer/status
# 期望：{"ok":true,"installed":true,...}
```

## 配置

手填价存在 `~/.dsh/price-mixer.json`（首次保存时自动创建，放在 `~/.dsh` 下，**插件升级/重装都不会冲掉**）：

```json
{
  "overrides": {
    "glm-5.3-max": { "input": 1.2, "output": 4.2, "cache_read": 0.3, "cache_write": 1.2 }
  }
}
```

- 单位：USD / 1M tokens；`cache_read` / `cache_write` 省略时默认等于 `input`。
- 删掉某个模型的键 = 回落到派生价；删掉整个文件 = 全部回落。

**生效时机**：dsh-context 自己缓存价格簿 1 小时，所以保存后要等它下一次取价，或重启宿主。这是上游缓存策略，本插件不去打补丁绕它。

## HTTP API

插件在 host 侧挂了一组路由（同一个 webServer，无需额外端口）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/price-mixer/status` | 壳状态、注入计数、价格簿状态、最近日志 |
| GET | `/price-mixer/models` | 全部模型 + 生效价 + 来源（不阻塞；价格簿未就绪时 `book.loading=true`） |
| POST | `/price-mixer/reload` | 强制重读权威价格簿（后台拉，立即返回） |
| POST | `/price-mixer/override` | `{ model, input, output, cache_read?, cache_write? }` 写手填价 |
| POST | `/price-mixer/reset` | `{ model }` 或 `{ all: true }` |

## 已知限制

- **Trae 源（`-max`）本来就不回报缓存**：这类模型的钱按输入全价算，是平台差异，不是计价错误。
- 注入的 provider 段按 models.dev 的**错峰价**计，不做 DeepSeek 家"工作日 9–12 / 14–18 点 ×2"的峰时加成（因为 provider 名不是 `deepseek`）。
- 给全局 `fetch` 挂壳**不是官方插件 API**，作用域只锁一个 URL。若上游改用别的 HTTP 栈，壳会拦空 → 退回拉真 models.dev，只是自定义价失效，不会坏别的东西。
- 只在 Web profile 上验证过（客户端面板需要 `slots` 插槽）。

## 回滚

1. `cordis.patch.yml` 删掉 `price-mixer` 区块（`# == dsh-price-mixer` 那几行）
2. `package.json` 删掉 `"dsh-price-mixer": "file:vendor/dsh-price-mixer"` 依赖行、以及 `dsh.profile.bundles` 里的 `"dsh-price-mixer"`
3. 重启 dsh

壳随进程消失，零残留。`~/.dsh/price-mixer.json` 可留可删。**全程没有改动 dsh-context 或任何第三方插件的文件。**

## 仓库结构

```
lib/index.js       host 半侧：fetch 壳、价格解析、注入、HTTP 路由
lib/client.js      浏览器半侧：侧栏面板（React via slots）
cordis.patch.yml   bundle 声明（插入 id: price-mixer）
package.json       含 dsh.bundle / dsh.client 声明与 exports
docs/*.jpg         面板截图
```

## 相关 issue

- dsh-context：希望内建"自定义模型价格 / 可配置价格源"入口 —— 见本仓库 issue 追踪与上游讨论。
- 本项目是**workaround**：上游一旦支持自定义价格源，本插件就可以退休。

## License

MIT © ymf2317-tech
