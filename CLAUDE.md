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

本機多 agent 訊息平台：任意數量的 agent session（Claude Code、Codex、Gemini CLI…）與人類使用者共用一個 broker，用 `@名字` / `@all` 收發訊息。另附 claude-split 隔離 launcher（選用）。純 Node stdlib + PowerShell，**零依賴、無 package.json、無 build、無測試框架**。文件與註解一律繁體中文。

## 架構

兩個正交機制，可獨立使用：

- **溝通（主體）**：`broker.js` 是常駐的訊息匯流排（NDJSON over `127.0.0.1:8787`，只存記憶體）。roster 成員表（lastSeen，TTL 預設 10 分鐘、`CLAUDE_MSG_STALE_MS` 覆寫）、`join` 防撞名、`who` 列成員、`to:"all"` 廣播給所有活著的成員（不含 sender、stale 不收）。
- **隔離（選用）**：`claude-split.ps1` 的 launcher（`claude-work` / `claude-personal`）把 `USERPROFILE` 指到假 home（`~\.claude-split\.claude-work` 等），讓兩實例的 `~\.claude.json`、`~\.claude\` 互不污染。broker 在 OS 層不受假 home 影響。

訊息流：`msg.js`（CLI）→ TCP → `broker.js`（每個名字一個 queue；`recv --wait N` 會 hold 住連線直到有訊息或逾時，這是回合制 agent 做到近即時的關鍵）。

身分優先序：`--as <名字>` > `CLAUDE_MSG_NAME` 環境變數（split launcher 注入）> 預設 `user`（人類）。agent 每次 shell 呼叫是新環境，所以 skill 指示 agent 每次帶 `--as`。

周邊元件：

- `msg-bus-skill/SKILL.md`：Claude Code skill。指示 agent 取名（專案＋任務兩詞）、join 上線、收發守則、聽取 loop（`recv --wait 540`、Bash timeout 600000、連續 2 次空即停）。
- `AGENTS-template.md`：跨 provider 通用指示範本（貼進 AGENTS.md / GEMINI.md）。
- `askpeer.js` + `ask-peer-skill/`：split 專用同步委派——用對方假 home 開一次性 `claude -p`（無狀態）。一問一答用 askpeer，多輪連貫用訊息平台。
- `msg.cmd`：Windows 包裝。agent 的 bash 找不到 `.cmd` 且會撞到系統 `msg.exe`，所以 **agent 一律用 `node <msg.js 路徑> ...`**（skill 用自帶複本路徑）；PowerShell 手動操作才用 `msg`（profile 有 function 蓋掉 msg.exe）。

## 開發與測試

沒有 build/lint/test 指令。手動驗證方式：

```powershell
# 起 broker（前景跑，直接看 log）
node broker.js

# 另開視窗，模擬多身分收發
node msg.js join alice
node msg.js send @alice --as bob "hi"
node msg.js recv --as alice --wait 5
node msg.js send @all --as user "廣播"
node msg.js who
node msg.js ping
```

完整驗證清單（含 TTL 回收、@all 三情境、skill 端對端）見 `docs/msg-bus-platform-plan.md` 的驗證章節。

## 部署注意

- 執行時用的是**複本**，不是這個 repo，有兩個部署位置：
  - `~\.claude\skills\claude-msg\`（skill：SKILL.md + msg.js + broker.js）→ 重跑 `Install-MsgBus -SourceDir <本 repo 路徑>`；split 的假 home 底下也各有一份（由 `Install-ClaudeSplit` 一併安裝）。
  - `~\.claude-split\bin\`（broker.js/msg.js/msg.cmd，供 `Start-ClaudeBroker` 與 PowerShell `msg` function）→ 重跑 `Install-ClaudeSplit`。
- broker 協定改動要同時看：`msg.js`、`msg-bus-skill/SKILL.md`、`AGENTS-template.md`、README 的協定速覽表。
