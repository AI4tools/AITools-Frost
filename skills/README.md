# Skills

本目录存放可复用的 skill（agent 技能包）。每个 skill 一个子目录，入口统一为 `SKILL.md`。

| Skill | 说明 | 入口 |
| --- | --- | --- |
| `opencode-external` | 让 OpenCode 之外的工具或脚本调用本机 OpenCode：发起/续接对话、指定免费模型。复用已在运行的共享服务，支持 HTTP 直连与 `opencode run` CLI。 | [SKILL.md](opencode-external/SKILL.md) |

## 安装

把整个 skill 目录放到 OpenCode 的 skills 路径下，重启即被发现：

```
~/.config/opencode/skills/opencode-external/
```

Windows：

```
%USERPROFILE%\.config\opencode\skills\opencode-external\
```

目录结构必须保持原样（`SKILL.md` 与 `scripts/`、`references/`、`models.json` 相对位置不变），脚本按相对路径加载同目录资源。

## 约定

- 目录名使用小写连字符；`SKILL.md` frontmatter 的 `name` 与目录名一致。
- 入口文件只放“何时用 + 怎么做”，细节拆到 `references/`。
- 可执行脚本放 `scripts/`，不依赖仓库外的绝对路径。
