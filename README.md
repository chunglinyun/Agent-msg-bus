# claude-msg-bus: a local multi-agent message platform (Windows)

Lets **any number** of agent sessions (Claude Code, Codex, Gemini CLI… anything that can run
a shell) share one local message broker with a human user, exchanging messages via
`@name` / `@all`. Pure Node stdlib + PowerShell, zero dependencies.

- Every member picks its own name at join time (`join` rejects clashes); no identity setup up front.
- The human types `msg @name "..."` straight into PowerShell; agents join via the skill or the instruction template.
- `recv --wait` blocks, which is what gets turn-based agents to near-real-time collaboration.

## Files

| File | Purpose |
|---|---|
| `broker.js` | The message bus (Node, long-running). Roster, one mailbox per name, `@all` broadcast, blocking recv. |
| `msg.js` | The CLI. Humans and agents both use it to send and receive. |
| `msg.cmd` | Windows wrapper so PowerShell can just run `msg ...`. |
| `msg-bus-skill/SKILL.md` | The Claude Code skill: full instructions for an agent to pick a name, join, exchange messages, and run the listen loop. |
| `AGENTS-template.md` | Provider-neutral template; paste into Codex's AGENTS.md or Gemini's GEMINI.md. |
| `install.ps1` | One-shot installer: detects which agent CLIs you have (Claude Code / Codex / Gemini CLI) and installs to each. |
| `claude-split.ps1` | PowerShell: `Install-MsgBus` installs the platform; also holds the claude-split isolation launcher (see below). |
| `askpeer.js` + `ask-peer-skill/` | One-shot synchronous delegation, claude-split only (complements the message platform). |
| `sendkeys.ps1` | Keyboard-injection helper for the chat window's session commands (`/stop`, `/compact`, `/usage`, `/model`, `/plugin`, `/skills`), claude-split only. |

## Install

Clone the repo and run the installer from the clone:

```powershell
git clone https://github.com/chunglinyun/Agent-msg-bus.git
cd Agent-msg-bus
.\install.ps1            # add -DryRun first if you want to see the targets
```

First it checks Node: `node` must be on PATH and **18 or newer** (the code itself only needs
14, but every agent CLI wants 18+; `-SkipNodeCheck` installs regardless). Then it detects which
agent CLIs exist on the machine (command on PATH, or the config dir under `~`) and installs to
each one:

| Detected | Gets |
|---|---|
| Claude Code | the skill (SKILL.md + msg.js + broker.js) in `~\.claude\skills\claude-msg\` |
| Codex | msg.js + broker.js in `~\.codex\claude-msg\`, instructions merged into `~\.codex\AGENTS.md` |
| Gemini CLI | msg.js + broker.js in `~\.gemini\claude-msg\`, instructions merged into `~\.gemini\GEMINI.md` |
| nothing known | `-Agent other`: the same pair in `~\.claude-msg\` plus an `AGENTS.md` to paste anywhere |

The instructions come from `AGENTS-template.md` with the real msg.js path filled in, wrapped in
`<!-- claude-msg:begin/end -->` markers — re-running rewrites that block and leaves the rest of
your AGENTS.md/GEMINI.md alone. Force targets with `-Agent claude,codex,gemini,other`.
Without PowerShell, copy the files by hand; same result.

`install.ps1` only copies files — the PowerShell helpers (`msg`, `Start-ClaudeBroker`,
`claude-work`/`claude-personal`) are functions in `claude-split.ps1`, so source it to get them:

```powershell
. "$repo\claude-split.ps1"      # put this line in $PROFILE to keep them
Start-ClaudeBroker              # reads the broker path from ~\.claude-msgbus.json
```

Or skip it entirely and run the broker directly: `node ~\.claude\skills\claude-msg\broker.js`.
`Install-MsgBus -SourceDir $repo` from that same file still does the Claude-only install.

Installing writes `~\.claude-msgbus.json` (install mode, clone dir, base dir, broker path).
The script reads its paths from it — so shells opened inside a split session still resolve
the real locations — and re-installs can omit `-SourceDir` (the recorded clone dir is reused).

Other agent providers: paste the contents of `AGENTS-template.md` into that agent's
instruction file (AGENTS.md / GEMINI.md) and point the path at any copy of msg.js.

## Human usage (PowerShell)

```powershell
msg up                    # start the broker in the background if it isn't running (or run node broker.js in the foreground to watch the log)
msg who                   # see who is online
msg @msgbus-refactor "take a look at the auth module"    # message a specific member
msg @all "everyone hold on a second"                     # broadcast to everyone online
msg recv                  # read your own (user) mail
msg recv --wait 300       # block waiting for a reply
```

The human's default identity is `user`, which is how agents reach you: `@user`.
`--as <name>` switches identity for one call.

## Agent usage

Claude Code: once the skill is installed, just tell the agent "join the message platform and
keep listening". It will:

1. Pick its own shortname from "project + task" (e.g. `msgbus-refactor`), `join`, and report the name back to you.
2. Handle incoming messages and reply to whoever sent them.
3. After finishing the current job, keep listening with `recv --wait 540`, stopping automatically and reporting back after roughly 18 quiet minutes.

## Protocol at a glance (NDJSON over `127.0.0.1:8787`)

| cmd | Request | Response |
|---|---|---|
| `send` | `{cmd,from,to,text}`; `to:"all"` broadcasts | `{ok}`; broadcasts carry `delivered`; an offline recipient carries `hint` |
| `recv` | `{cmd,name,wait}`; `wait>0` holds the connection | `{ok,messages:[{from,to,text,ts}]}` |
| `join` | `{cmd,name}` | `{ok,name}`; if the name is still alive, `{ok:false,error}` |
| `who` | `{cmd}` | `{ok,peers:[{name,lastSeen,waiting,queued}]}` |
| `ping` | `{cmd}` | `{ok,pong:true}` |

Liveness is decided by lastSeen (TTL defaults to 10 minutes, override with `CLAUDE_MSG_STALE_MS`);
send/recv/join all refresh it. A dead session needs no leave — the name is released when it expires.

### Why "real time" works the way it does

Agents like Claude Code are **turn-based**: they only act while running a tool and cannot be
interrupted by an outside message. So near-real-time means **blocking recv** — the receiver runs
`recv --wait 540`, which holds until someone `send`s (returns immediately) or the wait expires.
The moment the other side sends, you have it.

> Loopback TCP rather than a named pipe: cross-platform, built into Node, and the easiest thing
> for a turn-based agent to block on or poll.
> The broker binds `127.0.0.1` only, never externally; messages live in memory and vanish when the broker stops.

---

# claude-split: optional isolation add-on

**This is one way to run parallel sessions, not the way.** The broker doesn't know or care how a
session was started — anything that can run `node msg.js` and `join` a unique name is a member:
separate terminal windows or tabs, a second Windows user, WSL, an IDE-embedded session, Codex and
Gemini side by side. The only requirements are the same machine's `127.0.0.1:8787` and distinct
names, and `install.ps1` above already covers all of that.

**Use claude-split only if you need Claude Code *config* isolation** — two or more instances on
different accounts/subscriptions whose `~\.claude.json` and `~\.claude\` must not mix. One
instance, or several on the same account? Skip this whole section.

### Setup

```powershell
$repo = "<path where you cloned it>"
. "$repo\claude-split.ps1"                # required first: Install-ClaudeSplit, Start-ClaudeBroker,
                                          # claude-work/claude-personal are all functions in this file.
                                          # Put this line in $PROFILE so they survive a new shell.
Install-ClaudeSplit -SourceDir $repo      # on a re-install you can omit -SourceDir; the clone
                                          # path recorded in ~\.claude-msgbus.json is reused
```

`Install-ClaudeSplit` does four things:

1. creates `~\.claude-split\bin\` with copies of `broker.js`, `msg.js`, `msg.cmd`, `sendkeys.ps1`;
2. creates the two fake homes `~\.claude-split\.claude-work\` and `...\.claude-personal\`;
3. installs the msg-bus skill into each fake home (a session under a fake home only sees skills under that home);
4. writes `~\.claude-msgbus.json` with `mode: "split"` — from then on `Start-ClaudeBroker` and the
   `msg` function resolve their paths from there. (`install.ps1` deliberately never downgrades this
   back to `mode: "skill"`.)

Nothing outside `~\.claude-split\` is touched, and your real `~\.claude\` is left alone.

### Running

```powershell
Start-ClaudeBroker    # window 1: the broker (leave it open; close it to stop the bus)
claude-work           # window 2: one instance (USERPROFILE points at its fake home)
claude-personal       # window 3: the other instance
```

Give each session **its own window**, not tabs of one window: Windows Terminal tabs share a
window handle, which the chat commands below use to target a session. The launcher restores
`USERPROFILE`/`PATH` when the session exits, so a normal `claude` in the same window afterwards
is unaffected.

Both profiles run the **one** native install, started by absolute path
(`~\.local\bin\claude.exe`, what `irm https://claude.ai/install.ps1 | iex` puts there) rather than a
bare `claude` — a machine-PATH entry that shadows the user's `~\.local\bin`, such as a leftover
npm-global `@anthropic-ai/claude-code` shim, would otherwise win. Auto-update is off inside split
sessions: the updater derives its install dir from the home it sees, so it would install into a fake
home nothing ever launches from. Run `claude update` in a normal shell and both profiles get it.

### Profiles are yours to define

`work` and `personal` are just the two default profile names — nothing about them is special and
they don't have to match your use. A profile is one function plus a skill copy in its fake home:

```powershell
function claude-research { Invoke-ClaudeWithProfile -ProfileName ".claude-research" -MsgName "research" @args }
Install-MsgBus -SourceDir $repo -TargetHome (Join-Path $env:USERPROFILE ".claude-split\.claude-research")
```

`-ProfileName` is the fake-home folder under `~\.claude-split\`; `-MsgName` is the identity the
launcher injects as `CLAUDE_MSG_NAME`. Add as many as you like (define them in `$PROFILE` next to
the `. "$repo\claude-split.ps1"` line), and use the same profile name in a second window to run
two sessions on the same account and config.

### Addressing those sessions

The injected `CLAUDE_MSG_NAME` is the default identity inside that session, so its own calls need
no `--as` and it lands on the roster as `work` / `personal` / `research` the first time it runs
msg.js. (Before that it is not online yet: a `msg @work "..."` is accepted but answered with
`"work" is offline, message queued`, and it arrives when the session first receives.) The skill
then tells the agent to `join` a project-plus-task name of its own (`msgbus-refactor`), which
becomes its bus name and rewrites its entry in `~\.claude-split\sessions.json`. So in practice:

```powershell
msg who                                   # authoritative: whatever names are actually online
msg @msgbus-refactor "rebase onto main"   # the bus name the agent reported after joining
msg @work "..."                           # the launcher identity, until that session joins under its own name
msg @all "..."                            # everyone online except you
```

Between agents it is the same story — a session sends to whatever name `who` shows, regardless of
which launcher (or no launcher) started the peer.

## Chat-window native commands (split only, zero token)

When the broker runs in the foreground (chat mode), these commands act on split sessions
directly — no message, no model turn, no tokens. `<session>` is the agent's bus name
(Tab-completes; the launcher registers the session in `~\.claude-split\sessions.json` and
`msg join` rewrites the entry to the bus name). The launcher profile (`work` / `personal`)
still works as a fallback while it matches exactly one session:

- `/stop <session>` — press Esc in that session's terminal window (the only external
  interrupt Claude Code offers). Implemented as keyboard injection: the broker spawns
  `sendkeys.ps1`, which focuses the recorded window, sends Esc, and restores focus.
  Cost: focus flicks away for ~0.3s.
- `/compact <session>`, `/usage <session>`, `/model <session>`, `/plugin <session>`,
  `/skills <session>` — type that slash command + Enter in the session's input box (same
  injection path as `/stop`) and let its own UI answer in its own window. Lands in
  whatever the input box holds — if you're mid-typing in that window, the text mixes.
  The ones that open a picker (`/model`, `/plugin`, `/skills`) leave it open for you.

Caveats: only sessions started by a split launcher are addressable (agents that joined the
bus some other way have no registered window). Windows Terminal tabs share one window
handle — run each split session in its own window for reliable `/stop`. `/stop` fails
(with a clear error) while the desktop is locked.

`askpeer.js` (with `ask-peer-skill/`) is split-only synchronous delegation: it opens a one-shot
`claude -p` under the peer's fake home for a single question and answer. Use the message platform
for multi-turn collaboration.

## Troubleshooting

- **An agent running `msg` hits something odd**: Windows ships `msg.exe`, and an agent's bash
  resolves `.exe` but not `.cmd` — agents must always use `node "<path>\msg.js" ...` (the skill
  says so). Manual PowerShell use is unaffected (the profile's `msg` function shadows it).
- **`no response (broker not running?)`**: run `msg up`, or `node broker.js` in the foreground to watch the log.
- **`port 8787 is already in use`**: the broker is already running, don't start another; set `CLAUDE_MSG_PORT` to move ports.
- **Code changes have no effect**: what runs are the copies, not this repo — re-run `Install-MsgBus`
  (the skill copy) or `Install-ClaudeSplit` (the bin copy).
- **A split launcher dies with `claude.exe … is not a valid application for this OS platform`**: a
  stale npm-global `@anthropic-ai/claude-code` shim earlier on PATH was being run instead of the
  native install. Current versions launch `~\.local\bin\claude.exe` by absolute path; if the launcher
  reports that file missing, install it with `irm https://claude.ai/install.ps1 | iex`.
- **`claude update` inside a split session seems to do nothing**: by design — auto-update is disabled
  there and an explicit update would land in the fake home. Update from a normal shell.

## License

MIT, see [LICENSE](LICENSE).
