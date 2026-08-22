# Turning claude-msg-bus into a multi-session, cross-agent communication platform

## Context

Today's architecture is built for **exactly two fixed Claude sessions (work/personal)**: identity is
injected by the launcher as env vars, and the hook plus askpeer hard-code a binary peer. The goal is
to evolve it into a communication platform anyone can use: **any number of sessions (no fake home
required, not limited to Claude Code) can join**, humans and agents alike address each other with
`@name` / `@all`, an agent joining via the skill picks its own "project + task" shortname, and after
finishing a job keeps looping to listen for messages.

Decisions already made (confirmed with the user):
- **Isolation and communication fully decoupled**: the communication platform stands alone; claude-split is reduced to an isolation add-on.
- **Agents name themselves**; the broker only guards against clashes.
- **Cross-provider**: the CLI stays pure, neutral node; we ship a Claude SKILL.md plus a generic instruction template (pasteable into AGENTS.md/GEMINI.md).
- **Continuous listening is a skill loop over `recv --wait`**, not a Stop hook.
- **hook-recv.js gets deleted**, but only after `git init` + committing the current state (the repo is not yet a git repo).

Key facts confirmed during exploration: the broker core (queue/routing) is already name-agnostic, so
arbitrary names need no changes; the broker has no presence/roster/broadcast (all new); the hard-coding
sits in `hook-recv.js:65`, `askpeer.js:21-24`, and `claude-split.ps1:82-83`; `Install-ClaudeSplit` only
copies broker.js/msg.js/msg.cmd.

## Implementation steps

### 0. git init + commit the current state (user's request)

```powershell
git init; git add -A; git commit -m "initial commit: current work/personal binary architecture"
```

Each later phase gets its own commit; deleting `hook-recv.js` goes in a separate commit.
Per project convention, also save a copy of this plan to `docs/msg-bus-platform-plan.md`.

### 1. broker.js — roster / join / who / @all (+~35 lines)

Add a presence data structure (one Map is enough):

```js
const roster = new Map(); // name -> lastSeen (ms)
const STALE_MS = Number(process.env.CLAUDE_MSG_STALE_MS || 10 * 60 * 1000);
const touch = (name) => { if (name && name !== '?') roster.set(name, Date.now()); };
const alive = (name) => (Date.now() - (roster.get(name) || 0)) < STALE_MS;
```

- **Presence**: `touch()` in three places — `join` (name), `send` (from), `recv` (name). No leave, no heartbeat, no periodic cleanup; who and broadcast filter with `alive()`. Agents following the skill loop (wait 540s ≤ the 10-minute TTL) stay alive naturally, and a dead session's name is released 10 minutes later.
- **`join` cmd**: `{cmd:'join', name}`. Reject empty names, `all`, and anything starting with `@`; if `alive(name)` return `{ok:false, error:'already taken'}`, otherwise `touch` and return `{ok:true, name}`. join is not required (send/recv still work, keeping work/personal backwards compatible) — it's just the polite anti-clash step.
- **`who` cmd**: returns `{ok:true, peers:[{name, lastSeen, waiting, queued}]}`, alive members only. `waiting` = a waiter is currently blocked in recv; `queued` = queue length. Both one-line derivations of existing data.
- **`@all` broadcast**: a special case in the `send` branch for `req.to === 'all'`: run `deliverToWaiter || getQueue().push` once per roster member that is alive and ≠ sender (keeping `msg.to` as `'all'` so the receiver knows it's a broadcast), and return `{ok:true, delivered:N}`. Stale members are skipped (don't stuff a dead session's queue).
- **Unicast black-hole guard**: when the target isn't alive, the response also carries `hint: '"xxx" is offline, message queued'`, so a typo no longer vanishes silently.

Not doing: leave, channels/rooms, persistence, ACKs, roster pruning (YAGNI).

### 2. msg.js — --as / @ sugar / join / who / up (+~30 lines)

- **Identity precedence**: `--as <name>` > `CLAUDE_MSG_NAME` > `'user'` (the human default). Each of an agent's Bash calls is a fresh shell with no persistent env, so the skill teaches agents to pass `--as` every time; the split launcher's env injection keeps working; a human typing bare `msg` is `user`. Remove recv's "error if CLAUDE_MSG_NAME is unset" (msg.js:50).
- **`@` sugar**: strip a leading `@` from every `to` argument (`@all` → `'all'`); a first argument starting with `@` means send: `msg @foo "hi"` ≡ `msg send foo "hi"`.
- **New subcommands**:
  - `join <name>` → broker join, exit 1 on failure (the agent uses that to retry with another name).
  - `who` → prints one line per member: `name  (waiting|idle Ns)  queue:N`.
  - `up` → ping first, and only on failure `spawn(process.execPath, [__dirname/broker.js], {detached:true, stdio:'ignore'}).unref()`. Explicit start rather than implicit auto-spawn (avoids split brain and unpredictable behaviour); works as long as broker.js sits next to msg.js, which the self-contained install guarantees.
- **recv display**: prefix broadcast messages with `@all `; send prints the broker's `hint`.
- `whoami` now prints the resolved identity (including the `user` default).

### 3. msg-bus-skill/SKILL.md — the core deliverable (new file)

The repo holds only `msg-bus-skill/SKILL.md`; at install time `Install-MsgBus` assembles a
self-contained skill directory (SKILL.md + msg.js + broker.js copied into `~\.claude\skills\claude-msg\`).
Claude Code injects the Base directory when the skill loads, and SKILL.md tells the agent to use
"the msg.js in this skill directory" — **zero env-var dependency**, so any session can join without a fake home.

The frontmatter reuses ask-peer-skill's two-field format (name: claude-msg plus a long description carrying
the trigger phrases: "join the message platform", "come online", "listen for messages", "@xxx", "broadcast";
for one-shot delegation use ask-peer, not this skill).

Four sections in the body:

1. **Coming online and picking a name**: always `node "<skill dir>/msg.js" ...` (never a bare `msg`; bash hits the system msg.exe). `ping` first, `up` on failure, then `join`. Naming rules (few but firm): lowercase alphanumerics and `-`, 2 words within 20 characters; first word = the current project folder name (may be shortened), second word = one word for this task (e.g. `msgbus-refactor`); on a clash retry with `-2`/`-3` up to three times, then change the word. After a successful join, tell the user "I'm online as `<name>`, reach me at @<name>", and from then on **pass `--as <name>` on every call** (the name lives in the conversation context).
2. **Sending and receiving**: `send @peer --as <me> "..."`; `send @all` broadcasts; run `who` when you can't find someone; report the "offline, queued" hint faithfully. Reply to the sender of an `@all` message, not to all.
3. **The listen loop** (verbatim instructions): after finishing the current job run `recv --as <me> --wait 540`, and **the Bash tool timeout must be 600000** (the 10-minute ceiling; wait 540 leaves slack). Messages → handle each → send back to @from → resume listening; empty return → listen once more; **two empty returns in a row (about 18 minutes) → stop listening and report to the user**.
4. **Stop conditions**: the user says stop or sends a new instruction (user first), a peer says it's over, or two empty waits in a row. Principle: better to stop and ask than to burn tokens in an endless loop.

### 4. AGENTS-template.md — generic cross-provider template (new file, repo root)

A provider-neutral version of the SKILL.md body: the msg.js path left as a `<your install path>`
placeholder, and the wait seconds annotated "adjust to your shell tool's limit". Users paste it into
Codex's AGENTS.md or Gemini's GEMINI.md themselves.

### 5. claude-split.ps1 — Install-MsgBus (+~15 lines)

- **`Invoke-ClaudeWithProfile` untouched**: work/personal are just two fixed-name members on the platform, the env injection still applies (msg.js's fallback kicks in when `CLAUDE_MSG_NAME` is set), zero conflict.
- **New `Install-MsgBus`**: `param($SourceDir, $TargetHome=$env:USERPROFILE)`, copying `msg-bus-skill\SKILL.md` + `msg.js` + `broker.js` into `$TargetHome\.claude\skills\claude-msg\`. This is the only install step for regular users (no split).
- **Appended to `Install-ClaudeSplit`**: call `Install-MsgBus -TargetHome <fake home>` for each of `.claude-work`/`.claude-personal` (a split session only sees skills under its own fake home). The bin copy list is unchanged (`Start-ClaudeBroker` and the PowerShell `msg` function depend on it).

### 6. Delete hook-recv.js (separate commit, after the archival commit from step 0)

**Items to be deleted (user approved, on the condition of a git commit first)**: the whole `hook-recv.js`
file. askpeer.js and ask-peer-skill/ are untouched (they are synchronous delegation within the split
isolation story, orthogonal to platformisation).

### 7. Documentation

- **Rewrite README.md**: flip the structure to "platform first, split second". Top half: what the platform is, installation (Install-MsgBus or copying three files by hand), human usage (`msg up` / `msg who` / `msg @name "..."` / `msg @all "..."` / `msg recv`), agent usage (pointing at the skill), and a protocol table (send/recv/ping/join/who). Delete the current binary-"peer" template at lines 96-123, replacing it with "Claude installs the skill; other agents paste AGENTS-template.md". The split content in the bottom half carries over, reworded for the name-based model.
- **Update CLAUDE.md**: add roster/join/who/@all to the architecture section; change the deployment notes to two copy locations (`~\.claude-split\bin\` and `~\.claude\skills\claude-msg\`, each re-run its own Install-* after a change); remove the hook-recv.js references (including changing "protocol changes touch three clients" to two).

## Files changed

| File | Action |
|---|---|
| `broker.js` | Modify: roster, join, who, @all, offline hint |
| `msg.js` | Modify: --as, @ sugar, join/who/up subcommands |
| `msg-bus-skill/SKILL.md` | Add (the core deliverable) |
| `AGENTS-template.md` | Add |
| `claude-split.ps1` | Modify: Install-MsgBus, appended to Install-ClaudeSplit |
| `README.md`, `CLAUDE.md` | Rewrite / update |
| `docs/msg-bus-platform-plan.md` | Add (this plan, per project convention) |
| `hook-recv.js` | **Delete** (after the archival git commit) |
| `askpeer.js`, `ask-peer-skill/`, `msg.cmd` | Untouched |

## Verification (no test framework, manual)

Run `node broker.js` in the foreground to watch the log, with several PowerShell windows open:

1. **join clash**: `node msg.js join alice` succeeds → joining alice again fails → `join all` is rejected.
2. **TTL reclaim**: restart the broker with `CLAUDE_MSG_STALE_MS=3000`, join bob → wait 4 seconds → joining bob again succeeds.
3. **Send/receive and identity**: `send @alice --as bob "hi"` → `recv --as alice` shows `bob: hi`; `send @nobody "x"` produces the offline hint; bare `whoami` prints `user`.
4. **who**: lists alice/bob/user with waiting/queued.
5. **@all across three windows**: A blocks on `recv --as alice --wait 60`, B does `join carol` then idles, C runs `send @all --as user "hello everyone"` → A receives immediately (with the `@all` prefix), carol picks it up on a later recv, the sender receives nothing, and the response is `delivered:2`.
6. **msg up**: stop the broker → `up` → `ping` returns OK.
7. **End-to-end skill loop**: `Install-MsgBus` → open a plain claude session (no split) → "join the message platform and keep listening" → the agent reports its name → PowerShell `msg @<name> "reply pong"` → a reply arrives within seconds → stop sending, wait out two empty waits, and the agent should report that it stopped listening.
8. **Backwards compatibility**: run the old work/personal flow once (launcher env injection) to confirm it is unaffected.

## Risks

- **The 10-minute Bash ceiling**: if the agent forgets to set the timeout to 600000, the 120-second default cuts recv short (the broker's socket-close cleanup handles it, so no zombies, but it feels like recv returns early a lot). SKILL.md marks it in bold; if agents forget often in practice, fall back to wait 90 across more rounds.
- **TTL false death**: an agent heads-down for >10 minutes without touching the bus misses `@all` and may lose its name — an accepted trade-off, with `who`'s lastSeen providing observability.
- **Copy drift**: two deployment locations (bin, skills), and forgetting to reinstall after a code change is the biggest trap; CLAUDE.md's deployment section is the guard.
- **`msg up` has no log**: stdio ignore; run it in the foreground to see the log, and the ponytail comment marks the upgrade path.
