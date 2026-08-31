---
name: claude-msg
description: Join the local multi-agent message platform to exchange messages with other agent sessions and the human user, and to keep listening for requests. Use when the user says "join the message platform", "pick a name and come online", "listen for messages", "keep listening", "ask @somename", "broadcast to everyone", or "send a message to @xxx". Best for multi-turn collaboration and standing by; for one-shot stateless delegation use the ask-peer skill instead of this one.
---

# claude-msg: the multi-agent message platform

**Skill revision: 2026-08-31 12:08.** If the user asks which version of this skill you are running,
report that timestamp — it is the only way to tell whether your session loaded the current copy
(you read this file once, at load time, and cannot re-check it afterwards).

Invoked bare (e.g. `/claude-msg` with no further instruction), this means: come online,
then go straight into the listen loop in section 3 and stay there.

This skill directory ships its own `msg.js` and `broker.js` (copied in at install time), zero dependencies.
**Always call it as `node "<this skill directory>/msg.js" ...`** (the directory is the Base directory injected by the system);
never run a bare `msg` — bash won't find the .cmd and will hit Windows' own `msg.exe`.

## 1. Coming online and picking a name

1. `node "<dir>/msg.js" ping` — if it fails, run `node "<dir>/msg.js" up` to start the broker.
2. Pick a shortname; few rules, but firm ones:
   - Lowercase alphanumerics and `-` only, **two words, at most 20 characters**, easy to say and type.
   - First word = the current project folder name (may be shortened), second word = one word for this task.
     Example: refactoring in `claude-msg-bus` → `msgbus-refactor`.
3. `node "<dir>/msg.js" join <name>` — on a clash (exit 1) retry with `-2`, `-3`, up to three times; after that change the second word.
4. Once joined, **tell the user**: "I'm online as `<name>`; others can reach me at @<name>".
5. From then on, **pass `--as <name>` on every msg.js call** — each of your shell calls is a fresh
   environment and env vars don't persist; the name lives in your conversation context.

## 2. Sending and receiving

- Send: `node "<dir>/msg.js" send @peer --as <me> "text"`
- Broadcast: `node "<dir>/msg.js" send @all --as <me> "text"` (everyone online, excluding yourself)
- **Ask and wait in one shell call** — one tool call instead of two, the single biggest saving available:
  `node "<dir>/msg.js" send @peer --as <me> "question" && node "<dir>/msg.js" recv --as <me> --wait 300`
  What comes back is the next message to reach your queue, not necessarily that peer's answer; with three
  or more agents online, check the sender before treating it as the reply.
- See who's online: `node "<dir>/msg.js" who`, and run it before sending if you are unsure of a name.
- The human user's default name on the platform is `user`, so `@user` reaches the human.
- **Reply out the same channel the message came in on.** Anything you get from `recv` (you see it as
  `[time] <name>: ...`, `[time] user: ...` included) arrived on the bus, and that sender only sees the bus —
  your terminal markdown is invisible to them. Reply with `send @<name> --as <me>`. Don't assume the human
  reads your terminal just because they are the human; if they reached you over the bus, answer over the bus.
- If the send reports "is offline, message queued", report that faithfully to the user; don't pretend it was delivered.

**How to write a message.** The bus is a control channel between models — who is doing what, what was
decided, where the output is. It does not have to read well to a human: the human reads `docs/` and your
final reply. One extra round trip costs far more than a long message, so:

1. **Not addressed to you, no reply. Never ack.** No "got it", no "ok". If an `@all` does concern you, reply to the sender, not to @all.
2. **Conclusions and paths only.** Long content goes in a file; send the path with its section, never the content itself. Don't relay your process.
3. **Ask everything at once, answer everything at once.** Include every premise the other side needs to answer, and every result it needs next. **Rather too long than one more round trip** — this rule wins over the other four.
4. **Write for the receiving model.** No pleasantries, no restating context you both already have, no markdown decoration.
5. **Exception: surprises and decisions travel with their reason.** The test is whether it changes what the other side does next — `done: X` cannot say "I also changed the schema", and that is the part worth sending.

## 3. The listen loop (standing by)

After finishing the current job and replying, if you are in "keep listening" mode, run:

```
node "<dir>/msg.js" recv --as <me> --wait 540
```

**Set the Bash tool's timeout to 600000** (the 10-minute ceiling; wait 540 leaves a minute of slack
and keeps the broker's liveness check from treating you as offline).

The loop:
1. recv returns messages → handle each one: do the work → `send @from` with the result → back to 1.
2. recv returns empty (9 quiet minutes) → recv once more.
3. **Two empty returns in a row (about 18 minutes) → stop listening** and report to the user:
   "the channel is quiet, I've stopped listening; tell me to listen again whenever you want".

## 4. Running a background subagent while you listen

It is fine to offload heavy / context-polluting / slow research to a background subagent and keep the
`recv` loop live at the same time — the split is: heavy → subagent (returns conclusions + `file:line`,
keeps your context clean), immediate / lightweight (the listening) → you. Two things to get right:

1. **Say so up front.** Before you go back to waiting, tell the user a subagent is running and its result
   will come back **on its own** via a task-notification — but that notification only surfaces when your
   current `recv` call returns (a bus message arrives, or the wait times out), so it can lag a full wait
   cycle behind other traffic. It still needs no polling; just don't promise it will be instant.
2. **The result is pushed, not pulled.** Don't poll for it, and **don't read the subagent's transcript /
   output file to "check"** — that is a full JSONL dump that will blow up your context; the result arrives
   by itself. Until the notification lands, don't claim the background work is "lost" or "already back".

## 5. When to stop listening

- The user says stop, or the user sends a new instruction (**the user always comes first**).
- A peer's message says it's over ("done", "that's it for now").
- Two empty waits in a row (see above).

Principle: better to stop and ask the user than to burn tokens in an endless loop.
