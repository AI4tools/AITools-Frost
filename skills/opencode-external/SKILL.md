---
name: opencode-external
description: 让 OpenCode 之外的工具或脚本调用本机 OpenCode：发起新对话、续接对话、指定免费模型。复用已在运行的共享服务，不用另起服务器；支持 CLI（opencode run）与纯 HTTP 直连（/api/session）。当外部程序需要跑一个 prompt、挑选模型、或程序化驱动一个会话时使用。
---

# 外部调用 OpenCode

把本机 OpenCode 当成一个「可被外部调用的对话后端」：**发起新对话 / 续接对话 / 指定模型**。
“外部”指调用方不是 OpenCode 本身——可能是别的 agent、脚本、CI 或任何程序。

> **不需要另开服务器。** `opencode run`、`opencode api` 和本 skill 的脚本，连的都是**已经在跑的那个共享后台服务**。
> 只有你主动执行 `opencode serve` 或加 `--standalone` 才会新起服务，本 skill 不会这么做。

三条路：

| 方式 | 说明 | 需要什么 |
| --- | --- | --- |
| **HTTP 直连** | 纯 HTTP 打共享服务，任何语言可用 | 只读一个 json 文件 |
| **CLI** | `opencode run`，最简单 | `opencode` 可执行文件 |
| **`opencode api`** | 官方封装，自动发现+鉴权 | V2 CLI |

---

## 0. 共享服务在哪里（不用另开）

已经跑着的服务信息写在：

```
~/.local/state/opencode/service.json          # Windows: %USERPROFILE%\.local\state\opencode\service.json
```

```json
{ "id": "...", "version": "x.y.z", "url": "http://127.0.0.1:<port>", "pid": 12345, "password": "<generated>" }
```

- **鉴权是 Basic**：用户名固定 `opencode`，密码就是这里的 `password`。
- `url` 端口是**随机**的，所以别写死端口，每次都读这个文件。
- 文件不存在或 `pid` 已死（服务重启过）→ 改用 `opencode api`（它会自动发现并鉴权）。

查看当前解析到的服务：

```bash
node scripts/opencode.mjs service
# url        : http://127.0.0.1:<port>
# pid        : 12345 (alive)
# direct     : available
```

---

## 1. 可选模型：`models.json`

同目录 `models.json`，全部为**免费**模型，按档位（tier 越小越好）+ 并发能力排列：

| tier | alias | 模型 ID | variant | 并发 |
| --- | --- | --- | --- | --- |
| tier1 | `deepseek` | `opencode/deepseek-v4.1-flash-free` | high | 少并发 |
| tier1 | `glm` | `opencode/glm-5.3-flash-free` | high | 少并发 |
| tier2 | `spacebunny` | `opencode/space-bunny-free` | high | **不支持** |
| tier2 | `mimo` | `opencode/mimo-v2.6-flash-free` | — | **不支持** |
| tier2 | `nemotron` | `opencode/nemotron-3.5-super-vl-free` | high | 少并发 |
| tier3 | `step5` | `relay/<your-model>` | high | ?（极慢，示例中转，需自配） |
| tier3 | `longcat` | `opencode/longcat-2.5-preview-free` | — | ?（较弱） |

`--model` 接受：alias（`deepseek`）、tier（`tier1`/`tier2`/`tier3`）、完整 ID、或子串。
换模型只改 `models.json`，命令不动。

> **并发**：`spacebunny` / `mimo` **不支持并发**，同时发多个请求会失败/排队；要并发请用 `tier1`（deepseek/glm）或 `nemotron`（少量）。

---

## 2. 方式一：HTTP 直连（推荐给外部程序，零依赖）

### 2.1 原生 HTTP（curl / Python / 任何语言）

```bash
# 1) 读服务信息
SVC="$HOME/.local/state/opencode/service.json"     # Windows: %USERPROFILE%\.local\state\opencode\service.json
URL=$(node -pe "require('$SVC'.replace('~',process.env.HOME)).url")     # 或直接手填
PW=$(node -pe "require('$SVC'.replace('~',process.env.HOME)).password")

# 2) 建会话（带模型 + 工作目录）
curl -s "$URL/api/session" -u "opencode:$PW" -H 'Content-Type: application/json' \
  -d '{"title":"external","model":{"providerID":"opencode","id":"deepseek-v4.1-flash-free","variant":"high"},"location":{"directory":"D:/proj"}}'
# → {"data":{"id":"ses_xxx", ...}}

# 3) 发消息（立即返回，不代表答完）
curl -s "$URL/api/session/ses_xxx/prompt" -u "opencode:$PW" -H 'Content-Type: application/json' \
  -d '{"text":"用一句话介绍这个仓库"}'

# 4) 轮询消息，直到 idle 数量比本轮开始前多
curl -s "$URL/api/session/ses_xxx/message" -u "opencode:$PW"

# 5) 删会话
curl -s -X DELETE "$URL/api/session/ses_xxx" -u "opencode:$PW"
```

> 端口别写死。`-u "opencode:$PW"` 就是 Basic 鉴权。

### 2.2 用封装脚本（更省事）

```bash
# 一问一答：建 → 发 → 等 → 打印回复（默认【保留】会话，见下）
node scripts/opencode.mjs ask --model deepseek "用一句话介绍这个仓库"
node scripts/opencode.mjs ask --model glm --dir "D:/proj" --rm "review src/"   # 加 --rm 才删会话
# 中文 / 长 / 多行 prompt：从 UTF-8 文件读，绕开 shell 编码（见 §6「乱码」）
node scripts/opencode.mjs ask --model deepseek --dir "D:/proj" --prompt-file prompt.txt
# 或从 stdin 读（Node 里按 UTF-8 解码）
cat prompt.txt | node scripts/opencode.mjs ask --model deepseek --prompt-stdin

# 多轮
sid=$(node scripts/opencode.mjs session-create --model mimo --dir "D:/proj")
node scripts/opencode.mjs session-send --session $sid "第一条"
node scripts/opencode.mjs session-send --session $sid "接着上面"
node scripts/opencode.mjs session-delete --session $sid

# 清理旧会话（默认只预览，--force 才真删）
node scripts/opencode.mjs gc --older-than 24
node scripts/opencode.mjs gc --older-than 24 --force

# 原始端点直通
node scripts/opencode.mjs api get /api/model
```

> **为什么 `ask` 默认保留会话？** 建完立刻删，会让正在轮询共享服务的客户端（比如桌面版 UI）拿到一个已经消失的会话，弹
> 「请求失败 / Session not found」。所以删除改成显式 `--rm`；积攒的旧会话用 `gc`（默认只预览，`--force` 才删）统一清理。

默认走**直连**；缺失/失效时自动回退 `opencode api`。也可强制：`--via direct` / `--via cli`。

### 2.3 JSON 入口：`--json-args`（外部程序推荐）

不想拼一堆命令行参数？一个 JSON 对象说清楚要做什么。命令行 flag 优先级高于 JSON 值。

```bash
# 直接内联（PowerShell 5.1 会吃双引号，建议用下面 @文件 方式）
node scripts/opencode.mjs --json-args '{"func":"ask","model":"deepseek","text":"..."}'
# 从 UTF-8 JSON 文件读（推荐，绕开 shell 引号/编码坑）；也可以用子命令 `call` 等价触发
node scripts/opencode.mjs --json-args @task.json
node scripts/opencode.mjs call --json-args @task.json
```

| 字段 | 适用 func | 说明 |
| --- | --- | --- |
| `func`（必填） | 全部 | `create` / `ask` / `send` / `prompt` / `wait` / `delete` / `gc`（也支持完整名 `session-create` 等） |
| `model` / `tier` / `variant` | create/ask | 等价 `--model` / `--tier` / `--variant` |
| `agent` / `title` / `dir` | create/ask | 等价 `--agent` / `--title` / `--dir`（`dir` 要绝对路径） |
| `session` | send/prompt/wait/delete | 目标会话 ID |
| `text`（别名 `prompt`）、`promptFile`、`promptStdin` | ask/send/prompt | 消息内容；`promptFile`/`promptStdin` 按 UTF-8 读 |
| `timeout` | ask/send/wait | 等待本轮结束的超时 ms（默认 600000） |
| `rm` | ask | `true` = 用完即删（默认保留，原因见 §2.2 末尾） |
| `olderThan` / `force` | gc | gc 参数（同 `--older-than` / `--force`） |
| `via` | 全部 | `direct` / `cli` / `auto`（默认） |

```jsonc
{"func":"create","model":"glm","tier":"free","agent":"build","title":"review","dir":"D:/proj"}
// ↑ stdout = session id，stderr = 模型/目录信息
{"func":"ask","model":"deepseek","dir":"D:/proj","text":"用一句话介绍这个仓库"}
// ↑ 阻塞到本轮结束，stdout = 回复文本
{"func":"send","session":"ses_xxx","text":"接着上面"}
{"func":"wait","session":"ses_xxx","timeout":120000}
{"func":"prompt","session":"ses_xxx","text":"发出去就返回，不等"}
{"func":"delete","session":"ses_xxx"}
{"func":"gc","olderThan":24,"force":false}
```

---

## 3. 方式二：CLI（`opencode run`，V1/V2 通用）

### 直接用命令

```bash
# 开新对话并指定模型（#high 是变体，仅 V2）
"$OPENCODE_BIN" run --model "opencode/deepseek-v4.1-flash-free#high" "用一句话介绍这个仓库"

# V1 写法
"$OPENCODE_BIN" run --model "opencode/deepseek-v4.1-flash-free" --variant high "用一句话介绍这个仓库"

# 续接
"$OPENCODE_BIN" run --continue "接着上面继续"
"$OPENCODE_BIN" run --session ses_abc123 "继续"

# 机器可读（换行分隔 JSON 事件）
"$OPENCODE_BIN" run --format json --model deepseek "列出所有 TODO"
```

### 用封装脚本

```powershell
# Windows / PowerShell（不需要 node；有 PS7 时把 powershell 换成 pwsh）
powershell scripts/run.ps1 deepseek "用一句话介绍这个仓库"
powershell scripts/run.ps1 -Model glm -Title review "review src/"
powershell scripts/run.ps1 -Model glm -Continue "接着说"
powershell scripts/run.ps1 -List
powershell scripts/run.ps1 -Model glm -DryRun "review src/"   # 只打印将要执行的命令
```

```bash
# 跨平台 / Node
node scripts/opencode.mjs cli --model deepseek "用一句话介绍这个仓库"
node scripts/opencode.mjs cli -c "接着上面继续"

# bash
./scripts/run.sh -m deepseek "用一句话介绍这个仓库"
```

### 可执行文件

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCODE_BIN` | `opencode` | CLI 路径 |

判版本：`"$OPENCODE_BIN" --version`，含 `v2.` 为 V2。
- V2 才有 `api`/`service`/`mini`。
- 变体语法：V2 用 `provider/model#variant`；V1 用 `--model provider/model --variant high`。
- **V1 不自动带 variant**（部分上游会报 `Endpoint is unavailable`），只在显式 `-Variant` 时才加。

---

## 4. 消息结构（`GET /api/session/{id}/message`）

```jsonc
{
  "data": [
    { "type": "idle", "id": "msg_...", "outcome": "succeeded" },       // 本轮结束标志
    // 失败时：{ "type": "idle", "outcome": "failed", "error": { "type": "provider.no-route", "message": "Variant unavailable ..." } }
    { "type": "assistant", "agent": "build",
      "model": { "id": "deepseek-v4.1-flash-free", "providerID": "opencode", "variant": "high" },
      "content": [ { "type": "text", "text": "回复正文" } ],
      "finish": "stop", "cost": 0,
      "tokens": { "input": 7346, "output": 2, "cache": { "read": 512, "write": 0 } } },
    { "type": "user", "text": "你发的" }
  ],
  "cursor": { "previous": null, "next": null }
}
```

两个关键坑：

1. **数组是新的在前（≈倒序）**。取回复要按 `time.created` 取**最大**的 `type:"assistant"`，不要取“数组最后一条”。
2. **判断本轮结束**：`type:"idle"` 的**数量比本轮开始前多**。只看“存在 idle”在第二轮会立刻误判（上一轮的 idle 还在）。

更多端点见 `references/http-api.md`。

---

## 5. 并发（实测）

**结论：跨会话可以真并发；同一会话不行（排队）。**

| 场景 | 结果 | 实测 |
| --- | --- | --- |
| HTTP 直连 · 跨会话 ×6 | ✅ 真并行 | 6 路全部正确，总耗时 9.7s |
| `ask`（各自新会话）×4 | ✅ 真并行 | 总耗时 8.3s |
| `opencode run` 多进程 ×3 | ✅ 真并行 | 总耗时 5.0s（单个约 4s，明显重叠）|
| 同一会话连发 2 条 | ⚠️ 串行排队 | 两条都进同一会话，逐条处理，不并行 |

要点：

- **想并发就开多个会话**（每个请求一个 session）。`ask` 天然满足——每次调用都是独立新会话。
- **同一会话内不并行**：prompt 会排进该会话队列，顺序执行。
- 直连（`--via direct`）是**进程内 fetch**，无额外子进程开销，最适合高并发。
- 用 CLI 每次起一个进程；能并行但开销大，且注意下面的 stdin 坑。

### ⚠️ 外部调 CLI 的 stdin 坑（最容易踩）

`opencode run` 在 **stdin 是「管道且不关闭」时会一直等 stdin**，表现为「卡死不返回」。外部程序（Node `spawn`、Python `subprocess`、CI）的默认 stdin 恰好就是这种。

- 单进程 + stdin 管道 → **卡死**（实测 90s 未返回）
- 单进程 + stdin 关闭/空设备 → 5.4s 正常
- 3 进程并发 + stdin 空设备 → 全部成功，5.0s

所以外部调 `opencode run` 时务必把 **stdin 接到空设备**：

```js
// Node
spawn(BIN, args, { stdio: ['ignore', 'inherit', 'inherit'] });   // stdin: 'ignore' 是关键
```

```python
# Python
subprocess.run([BIN, 'run', '--model', 'x/y', '...'], stdin=subprocess.DEVNULL)
```

本 skill 的 `opencode.mjs cli` 已内置 `stdin: 'ignore'`，不会踩这个坑。

---

## 6. 排错

| 现象 | 处理 |
| --- | --- |
| 中文 prompt 变成乱码（如「浣犳槸涓€涓?」）| **编码问题**：读 prompt 文件时按 ANSI/GBK 解码了 UTF-8。PowerShell 5.1 的 `Get-Content`（不带 `-Encoding`）最常犯。改用 `--prompt-file` / `-PromptFile`（脚本内部按 UTF-8 读），或 `Get-Content -Raw -Encoding UTF8 prompt.txt` |
| 直连 401 | 密码读错或服务重启过；重读 `service.json`，或 `--via cli` |
| `service.json` 不存在 / pid DEAD | 服务没起或已重启 → 回退 `opencode api`；或让它随桌面应用启动 |
| `Expected a valid JSON body` | PowerShell 传 JSON 会吞引号 → 用 Node 脚本或 curl（见 references） |
| `opencode api` 不存在 | CLI 是 V1；HTTP 用直连，或切 V2 CLI |
| `ServiceUnavailable` 503 | `"$OPENCODE_BIN" service status` / `service restart` |
| `model turn failed: Variant unavailable ...` | 该模型没有这个 variant（`mimo`/`longcat` 只有 default）；去掉 `--variant` 或换模型 |
| `model turn failed: ... Model is unavailable` | 上游/中转离线；`step5` 走的是**示例中转**，换成你自己的中转地址或直接改用 `tier1` |
| 模型无权限 | `"$OPENCODE_BIN" auth list` |
| 会话跑到别处 | 传 `--dir` / `-d`（脚本会设工作目录） |
| CLI「卡死不返回」| 子进程 stdin 是未关闭的管道 → 把 stdin 接到空设备（见 §5）|

## 7. 安全

- `service.json` 里的 `password` 等同于本机服务的管理凭据，**不要外传 / 提交到仓库**。直连脚本只在本机读它。
- `opencode run` 默认会**询问权限**；外部自动调用若要免交互加 `--auto`，但它会**自动批准一切未被显式拒绝的操作（危险）**，只在受控环境用。
