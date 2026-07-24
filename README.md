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
| `claude-split.ps1` | PowerShell: `Install-MsgBus` installs the platform; also holds the claude-split isolation launcher (see below). |
| `askpeer.js` + `ask-peer-skill/` | One-shot synchronous delegation, claude-split only (complements the message platform). |
| `sendkeys.ps1` | Keyboard-injection helper for the chat window's `/stop` command, claude-split only. |

## Install

Clone the repo anywhere, then point the install at the clone:

```powershell
git clone https://github.com/chunglinyun/Agent-msg-bus.git
$repo = "<path where you cloned it>"      # e.g. C:\src\Agent-msg-bus
. "$repo\claude-split.ps1"                # source it (best put in $PROFILE)
Install-MsgBus -SourceDir $repo
```

This installs the skill (SKILL.md + msg.js + broker.js) into `~\.claude\skills\claude-msg\`,
self-contained — every Claude Code session of yours can join the platform from then on.
Without PowerShell, copy those three files there by hand; same result.

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

**When you need it**: only when you run **two or more Claude Code instances side by side**
(e.g. different accounts or subscriptions) and want their `~\.claude.json` / `~\.claude\`
kept separate. Running a single instance, or several instances on the same account?
Skip this whole section — `Install-MsgBus` above is all the message platform needs.

```powershell
Install-ClaudeSplit -SourceDir $repo      # $repo = your clone path, as above
```

This creates `~\.claude-split\bin\` (copies of broker.js/msg.js/msg.cmd/sendkeys.ps1) and two fake homes
(`.claude-work` / `.claude-personal`, each with the msg-bus skill installed), and then:

```powershell
Start-ClaudeBroker    # window 1: the broker
claude-work           # window 2: one instance (USERPROFILE points at its fake home)
claude-personal       # window 3: the other instance
```

`work` and `personal` are just the two **default profile names** — nothing about them is
special, they don't have to match your use. Each profile is one line; add your own alongside
the built-in two (and give it the skill copy):

```powershell
function claude-research { Invoke-ClaudeWithProfile -ProfileName ".claude-research" -MsgName "research" @args }
Install-MsgBus -SourceDir $repo -TargetHome (Join-Path $env:USERPROFILE ".claude-split\.claude-research")
```

The launcher injects `CLAUDE_MSG_NAME` (the profile's MsgName), so each instance is a member
with a fixed name — no join, no `--as`. They can still exchange messages with any other member as usual.

## Chat-window native commands (split only, zero token)

When the broker runs in the foreground (chat mode), two commands act on split sessions
directly — no message, no model turn, no tokens. `<profile>` is the launcher's MsgName
(`work` / `personal` by default, or whatever you named your own profiles):

- `/stop <profile>` — press Esc in that session's terminal window (the only external
  interrupt Claude Code offers). Implemented as keyboard injection: the launcher records the
  window in `~\.claude-split\sessions.json`, the broker spawns `sendkeys.ps1`, which focuses
  the window, sends Esc, and restores focus. Cost: focus flicks away for ~0.3s.
- `/usage <profile>` — token totals (today / all time) computed by reading that fake
  home's transcripts (`.claude\projects\**\*.jsonl`). No injection at all.

Caveats: targets are launcher profile names, not bus names (they usually coincide, but a
session that joined the bus some other way isn't addressable). Windows Terminal tabs share
one window handle — run each split session in its own window for reliable `/stop`. `/stop`
fails (with a clear error) while the desktop is locked.

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
- **Split downloads a separate claude.exe the first time a profile runs**: the home was changed; that's expected.

## License

MIT, see [LICENSE](LICENSE).
