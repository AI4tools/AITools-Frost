# OpenCode V2 HTTP API - 外部调用参考

本机 V2 CLI 自带 `api` 子命令，会**自动发现后台服务并完成鉴权**（直接对服务端口发 HTTP 会 401）。
官方文档：<https://opencode.ai/v2/docs/api/>，OpenAPI：<https://opencode.ai/v2/openapi.json>。

```
opencode api <method> <path> [--data JSON] [--header name:value] [--param key=value]
```

也可以按 operation id 调用（文档例：`opencode api session.create --data '{...}'`）。

---

## 会话流程

### 1. 创建会话 `POST /api/session`

Request body（`Session.CreateInput`）：

```json
{
  "title": "string|null",
  "parentID": "ses_...|null",
  "agent": "build|null",
  "model": { "providerID": "opencode", "id": "deepseek-v4.1-flash-free", "variant": "high" },
  "location": { "directory": "D:\\absolute\\path" },
  "metadata": {},
  "permissions": []
}
```

- `model`（`Model.Ref`，必填 `id` + `providerID`）：`id` 是**不含 provider 前缀**的模型 ID。
- `location.directory` 必须是**绝对路径**；省略则用服务当前目录。

Response：`{ "data": Session.Info }`

```jsonc
{
  "data": {
    "id": "ses_000000000000000000000000",
    "projectID": "<project-id>",
    "agent": "build",
    "model": { "id": "deepseek-v4.1-flash-free", "providerID": "opencode", "variant": "high" },
    "cost": 0,
    "tokens": { "input": 0, "output": 0, "reasoning": 0, "cache": { "read": 0, "write": 0 } },
    "time": { "created": 1700000000000, "updated": 1700000000000 },
    "title": "external",
    "location": { "directory": "D:\\path\\to\\project" }
  }
}
```

### 2. 发消息 `POST /api/session/{sessionID}/prompt`

Request body（必填 `text`）：

```json
{
  "text": "string",
  "files": [{ "..." : "PromptInput.FileAttachment" }],
  "delivery": "steer|queue",
  "resume": true
}
```

Response：`{ "data": Session.Inbox.User }` —— **立即返回**，不代表模型已经答完。要拿回复需轮询消息或订阅事件。

### 3. 读消息 `GET /api/session/{sessionID}/message`

Response：`{ "data": Session.Message.Info[], "cursor": { "previous": null, "next": null } }`

消息 `type` 判别：

| type | 关键字段 |
| --- | --- |
| `user` | `text` |
| `assistant` | `content[]`（`type:"text"` → `text`；也有 tool 项）、`model`、`finish`、`cost`、`tokens` |
| `idle` | `outcome`: `succeeded` / `failed` / `interrupted` —— **本轮结束标志** |
| `agent-selected` / `model-selected` / `system` / `skill` / `shell` / `compaction` | 其它信息 |

真实样例：

```jsonc
[
  { "id": "msg_000000000001", "time": { "created": 1700000000100 },
    "text": "Reply with exactly two characters: OK.", "type": "user" },
  { "id": "msg_000000000002",
    "time": { "created": 1700000000200, "streamed": 1700000004500, "completed": 1700000004600 },
    "type": "assistant", "agent": "build",
    "model": { "id": "deepseek-v4.1-flash-free", "providerID": "opencode", "variant": "high" },
    "content": [ { "type": "text", "text": "OK" } ],
    "finish": "stop", "rawFinish": "stop", "cost": 0,
    "tokens": { "input": 7346, "output": 2, "reasoning": 0, "cache": { "read": 512, "write": 0 } } },
  { "id": "msg_000000000003", "time": { "created": 1700000004700 },
    "type": "idle", "outcome": "succeeded" }
]
```

**取回复**：**消息是新的在前**（数组顺序 ≈ 倒序），所以取 `time.created` 最大的那条 `type:"assistant"`，把 `content` 里 `type:"text"` 的 `text` 拼接。不要简单取“数组最后一条”。

**判断本轮结束**：轮询到 `type:"idle"` 的**数量比本轮开始前多**为止。仅判断“存在 idle”在第二轮会立即误判（上一轮的 idle 还在列表里）。

```js
const base = (await messages(sid)).filter(m => m.type === 'idle').length;
await prompt(sid, text);
// 轮询，直到 idle 数量 > base
```

### 4. 切模型 / 切 agent

```
POST /api/session/{sessionID}/model   {"model": {"providerID":"opencode","id":"glm-5.3-flash-free","variant":"high"}}
POST /api/session/{sessionID}/agent   {"agent": "build"}
```

### 5. 删除会话

```
DELETE /api/session/{sessionID}
```

---

## 其它端点

| 资源 | 端点 |
| --- | --- |
| 会话列表 | `GET /api/session` |
| 会话详情 | `GET /api/session/{sessionID}` |
| Fork 会话 | `POST /api/session/{sessionID}/fork` |
| 中断 | `POST /api/session/{sessionID}/interrupt` |
| 事件流（SSE） | `GET /api/event`（`text/event-stream`） |
| 模型列表 | `GET /api/model` → `{ location, data: Model.Info[] }` |
| Agent 列表 | `GET /api/agent` |
| Skill 列表 | `GET /api/skill` |
| 权限请求 / 回复 | `GET /api/session/{sid}/permission` · `POST /api/session/{sid}/permission/{requestID}/reply` |
| 表单（input_required） | `GET/POST /api/session/{sid}/form` · `POST .../form/{formID}/reply` |

---

## 直连共享服务（推荐的“外部”用法）

**不用另开服务器**，直接连已在运行的服务：

```
~/.local/state/opencode/service.json
{ "version":"x.y.z", "url":"http://127.0.0.1:<port>", "pid":12345, "password":"<generated>" }
```

- **鉴权：Basic**，用户名 `opencode`，密码为 `password`。
- 端口随机，每次从该文件读 `url`。
- `pid` 不在进程表里说明服务重启过 → 重读文件或走 `opencode api`。

```bash
SVC="$HOME/.local/state/opencode/service.json"
URL=$(node -pe "require(process.env.HOME+'/.local/state/opencode/service.json').url")
PW=$(node -pe  "require(process.env.HOME+'/.local/state/opencode/service.json').password")

curl -s "$URL/api/session" -u "opencode:$PW" -H 'Content-Type: application/json' \
  -d '{"title":"t","model":{"providerID":"opencode","id":"deepseek-v4.1-flash-free"},"location":{"directory":"D:/proj"}}'
```

Node 直接 fetch：

```js
const svc = JSON.parse(require('fs').readFileSync(
  require('path').join(require('os').homedir(), '.local/state/opencode/service.json'), 'utf8'));
const auth = 'Basic ' + Buffer.from(`opencode:${svc.password}`).toString('base64');
const r = await fetch(svc.url + '/api/session', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 't', model: { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' } }),
});
```

`scripts/opencode.mjs` 默认就走这条直连（无子进程）。

---

## 传输细节 / 坑

### 回退：`opencode api`

状态文件缺失或上面的 pid 已死时，用官方封装（自动发现 + 鉴权）：

```
opencode api <method> <path> [--data JSON]
```

### PowerShell 传 JSON

PS 5.1 传给原生 exe 时会**吞掉双引号**（→ `Expected a valid JSON body`），body 带空格还会被**按空格拆参数**。
所以：**优先用 `scripts/opencode.mjs` 或 curl**。

若必须手写 PowerShell，需把 `"` 转义成 `\"`：

```powershell
$bin = $env:OPENCODE_BIN
$body = '{"title":"t1"}' -replace '(?<!\\)"','\"'
$raw = (& $bin api post /api/session --data $body 2>&1 | Out-String)
($raw.Trim() | ConvertFrom-Json).data.id
```

### Node 直接 spawn `opencode` 的坑

Node ≥ 20.12 拒绝无 shell 执行 `.cmd` shim（ENOENT），而 `shell:true` 会**拼接**参数破坏 JSON。
`scripts/opencode.mjs` 的 `resolveBin()` 会解析 npm shim 拿到真实 `.exe`，从而无 shell 精确传参。

