# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# Planning Convention

Anything touching several files at once, the broker protocol, or the split launcher's behaviour gets
a plan document in `docs/<topic>-plan.md`, approved by the project owner before implementation — see
the existing ones (`msg-bus-platform-plan.md`, `session-registry-busname-plan.md`, …) for the shape:
problem, design, file-by-file changes, verification list. Don't bundle unrelated changes into an
approved plan. A one-line fix doesn't need a plan.

# Mandatory Verification Before Modifying Files

**Before performing any Edit or Write operation on a file, you must first use the Read tool to read the file's current contents.**

Session summaries or conversation history only describe what was done previously—they do **not** guarantee the file's current state. The user may have modified files between conversations without committing the changes. Likewise, `git diff` only shows differences from the last commit and cannot detect all uncommitted modifications.

Therefore:

- **Do not modify a file based solely on information from a session summary or previous conversation.** Always read the file first to verify its current contents.
- **If the actual file content differs from what the session summary describes, stop and inform the user of the differences before making any changes.**
- **Before removing any method, class, or field, explicitly list every item that will be removed and wait for the user's confirmation before proceeding.**


## What this is

A local multi-agent message platform: any number of agent sessions (Claude Code, Codex, Gemini CLI…) share one broker with the human user, exchanging messages via `@name` / `@all`. It also ships the optional claude-split isolation launcher. Pure Node stdlib + PowerShell, **zero dependencies, no package.json, no build, no test framework**. Docs and comments are written in English.

## Architecture

Two orthogonal mechanisms, usable independently:

- **Communication (the main thing)**: `broker.js` is a long-running message bus (NDJSON over `127.0.0.1:8787`, memory only). It holds the roster (lastSeen, TTL default 10 minutes, override with `CLAUDE_MSG_STALE_MS`), `join` for clash protection, `who` to list members, and `to:"all"` to broadcast to every live member (excluding the sender; stale members are skipped).
- **Isolation (optional)**: the launchers in `claude-split.ps1` (`claude-work` / `claude-personal`) point `USERPROFILE` at a fake home (`~\.claude-split\.claude-work` and so on) so the two instances' `~\.claude.json` and `~\.claude\` never mix. The broker sits at the OS level and is unaffected by fake homes. Consequences of the faked home, both handled in `Invoke-ClaudeWithProfile`: the binary is started by absolute path (`<real home>\.local\bin\claude.exe`) because a bare `claude` can resolve to something else on machine PATH (e.g. a leftover npm-global shim), and `DISABLE_AUTOUPDATER=1` is set because the updater derives its install dir from the home it sees and would install into a fake home nothing launches from — update in a normal shell.

Message flow: `msg.js` (CLI) → TCP → `broker.js` (one queue per name; `recv --wait N` holds the connection until a message arrives or the wait expires, which is what makes near-real-time possible for turn-based agents).

Identity precedence: `--as <name>` > the `CLAUDE_MSG_NAME` env var (injected by the split launcher) > the default `user` (the human). Every shell call an agent makes is a fresh environment, which is why the skill tells agents to pass `--as` each time.

Supporting pieces:

- `msg-bus-skill/SKILL.md`: the Claude Code skill. Tells the agent how to pick a name (project + task, two words), join, follow the messaging rules, and run the listen loop (`recv --wait 540`, Bash timeout 600000, stop after two empty returns).
- `AGENTS-template.md`: the provider-neutral instruction template (paste into AGENTS.md / GEMINI.md).
- `askpeer.js` + `ask-peer-skill/`: split-only synchronous delegation — a one-shot `claude -p` under the peer's fake home (stateless). Use askpeer for a single question and answer, the message platform for multi-turn work.
- **Session commands** (`/stop`, `/compact`, `/usage`, `/model`, `/plugin`, `/skills`) are zero-token keystroke injection, and the chain spans four files: `claude-split.ps1` writes `sessions.json` (one entry per launcher process: name, profile, pid, hwnd) into the home of the install that owns the broker — `~\.claude` for a skill install, `~\.codex` / `~\.gemini` for those agents, `~\.claude-split` for split; both writers derive it the same way, as the nearest ancestor of the installed copy whose name starts with a dot → `msg join` sends `CLAUDE_SPLIT_SESSION_PID` and the **broker** rewrites that entry's `name` to the agent's bus name (the broker owns the file; the fake `USERPROFILE` makes the path underivable from inside a split session) → the broker's chat mode matches `/<cmd> <target>`, looks the target up by name then profile (>1 hit = ambiguous, refuse) → `sendkeys.ps1` focuses that HWND, sends the keys, restores focus (exit code 2 = that window is gone, and the broker drops the entry). Windows Terminal tabs share one HWND, so targeting is only reliable with one session per window.
  - The window handle can only be captured at a shell prompt (`GetForegroundWindow()`; a console program's `MainWindowHandle` is 0 and ConPTY's `GetConsoleWindow()` cannot be focused), never from inside a running session. Hence two entry points and no third: the launcher functions (`claude`, `claude-work`, `claude-personal` — `claude` is the plain one, real home, register on start + unregister on exit) and the manual `msg register <name>` fallback. Sessions in the Claude desktop app cannot be targeted at all.
- `msg.cmd`: the Windows wrapper. An agent's bash won't find `.cmd` and will hit the system `msg.exe`, so **agents always use `node <path to msg.js> ...`** (the skill uses its own bundled copy); `msg` is only for manual PowerShell use (the profile function shadows msg.exe).

## Development and testing

There are no build/lint/test commands. Manual verification:

```powershell
# Start the broker (foreground, so you can watch the log)
node broker.js

# In another window, simulate several identities sending and receiving
node msg.js join alice
node msg.js send @alice --as bob "hi"
node msg.js recv --as alice --wait 5
node msg.js send @all --as user "broadcast"
node msg.js who
node msg.js ping
```

The full verification list (TTL reclaim, the three @all scenarios, the end-to-end skill run) is in the verification section of `docs/msg-bus-platform-plan.md`.

## Deployment notes

- What runs are **copies**, not this repo, and there are two deployment locations:
  - `~\.claude\skills\claude-msg\` (the skill: SKILL.md + msg.js + broker.js + sendkeys.ps1) → re-run `Install-MsgBus -SourceDir <path to this repo>`; split's fake homes each hold a copy too (installed by `Install-ClaudeSplit`).
  - `~\.claude-split\bin\` (broker.js/msg.js/msg.cmd, used by `Start-ClaudeBroker` and the PowerShell `msg` function) → re-run `Install-ClaudeSplit`.
  - Other providers, if `install.ps1` detected them: `~\.codex\claude-msg\` + `~\.codex\AGENTS.md`, `~\.gemini\claude-msg\` + `~\.gemini\GEMINI.md` (the instruction block is delimited by `<!-- claude-msg:begin/end -->` and rewritten in place) → re-run `.\install.ps1`.
- A change to the broker protocol means also checking: `msg.js`, `msg-bus-skill/SKILL.md`, `AGENTS-template.md`, and the protocol table in the README.
