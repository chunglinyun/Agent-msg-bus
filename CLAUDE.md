# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# Planning & Refactor Conventions

**Before starting any development work (new features, refactoring, or architectural changes), you must read and follow the `planning-refactor` skill (`.agent/skills/planning-refactor/SKILL.md`).** This document defines when a plan is required, the required plan document format, the review/approval process, severity levels, and scope control principles.

**Golden Rule (always applies):**  
Any refactoring involving multiple classes, interface changes, or architectural changes **must** have a plan document (for example, `docs/xxx-plan.md`) created and approved by the project owner before implementation begins. Do not make additional unrelated changes outside the approved plan.

# Documentation Placement Conventions

- **`docs/`** — Planning and documentation artifacts, such as implementation plans, refactoring proposals, and checklists.
- **`Obsidian/`** — Obsidian vault for analysis-oriented documentation (for example, data model ↔ worker relationship diagrams and worker documentation). Use `[[wikilink]]` to connect related notes. Worker documentation should be placed under `Obsidian/worker/`.

# Mandatory Verification Before Modifying Files

**Before performing any Edit or Write operation on a file, you must first use the Read tool to read the file's current contents.**

Session summaries or conversation history only describe what was done previously—they do **not** guarantee the file's current state. The user may have modified files between conversations without committing the changes. Likewise, `git diff` only shows differences from the last commit and cannot detect all uncommitted modifications.

Therefore:

- **Do not modify a file based solely on information from a session summary or previous conversation.** Always read the file first to verify its current contents.
- **If the actual file content differs from what the session summary describes, stop and inform the user of the differences before making any changes.**
- **Before removing any method, class, or field, explicitly list every item that will be removed and wait for the user's confirmation before proceeding.**


## 這是什麼

讓兩個「隔離但可溝通」的 Claude Code 實例（work / personal）在 Windows 上並存的工具組。純 Node stdlib + PowerShell，**零依賴、無 package.json、無 build、無測試框架**。文件與註解一律繁體中文。

## 架構

兩個正交機制組合：

- **隔離**：`claude-split.ps1` 的 launcher（`claude-work` / `claude-personal`）把 `USERPROFILE` 指到假 home（`~\.claude-split\.claude-work` 等），讓兩實例的 `~\.claude.json`、`~\.claude\` 互不污染。
- **溝通**：`broker.js` 是常駐的訊息匯流排（NDJSON over `127.0.0.1:8787`，只存記憶體）。broker 在 OS 層，不受假 home 影響，所以隔離與溝通並存。

訊息流：`msg.js`（CLI）→ TCP → `broker.js`（每個名字一個 queue；`recv --wait N` 會 hold 住連線直到有訊息或逾時，這是回合制 agent 做到近即時的關鍵）。

周邊元件：

- `hook-recv.js`：Claude Code 的 Stop hook。agent 收尾時去 broker 收信，有訊息就回 `{decision:"block", reason:...}` 讓 agent 繼續處理。環境變數 `CLAUDE_HOOK_WAIT` 可加等待窗口。
- `askpeer.js` + `ask-peer-skill/`：同步委派——用對方假 home 開一次性 `claude -p`（無狀態）。與 msg channel 互補：一問一答用 askpeer，多輪連貫用 channel。
- `msg.cmd`：Windows 包裝。agent 的 bash 找不到 `.cmd` 且會撞到系統 `msg.exe`，所以 **agent 一律用 `node "$CLAUDE_MSG" ...`**；PowerShell 手動操作才用 `msg`（profile 有 function 蓋掉 msg.exe）。

身分（`CLAUDE_MSG_NAME`）、埠號（`CLAUDE_MSG_PORT`）、msg.js 路徑（`CLAUDE_MSG`）都由 launcher 注入環境變數，工具本身不寫死。

## 開發與測試

沒有 build/lint/test 指令。手動驗證方式：

```powershell
# 起 broker（前景跑，直接看 log）
node broker.js

# 另開視窗，模擬兩個身分收發
$env:CLAUDE_MSG_NAME = "work";     node msg.js send personal "hi"
$env:CLAUDE_MSG_NAME = "personal"; node msg.js recv --wait 5
node msg.js ping
```

## 部署注意

- 執行時用的是 **`~\.claude-split\bin\` 裡的複本**，不是這個 repo。改完程式要重跑 `Install-ClaudeSplit -SourceDir <本 repo 路徑>`（或手動複製）才生效。
- `Install-ClaudeSplit` 目前只複製 `broker.js`、`msg.js`、`msg.cmd`——`hook-recv.js` 與 `askpeer.js` 不在清單內，新增檔案時記得同步更新 `claude-split.ps1` 的複製清單。
- broker 協定改動要同時看三個 client：`msg.js`、`hook-recv.js`、以及 README 裡給假 home CLAUDE.md 的使用說明。
