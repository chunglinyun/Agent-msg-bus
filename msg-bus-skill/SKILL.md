---
name: claude-msg
description: Join the local multi-agent message platform to exchange messages with other agent sessions and the human user, and to keep listening for requests. Use when the user says "join the message platform", "pick a name and come online", "listen for messages", "keep listening", "ask @somename", "broadcast to everyone", or "send a message to @xxx". Best for multi-turn collaboration and standing by; for one-shot stateless delegation use the ask-peer skill instead of this one.
---

# claude-msg: the multi-agent message platform

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
- See who's online: `node "<dir>/msg.js" who`
- The human user's default name on the platform is `user`, so `@user` reaches the human.

Rules:
- When unsure of a peer's name, run `who` before sending.
- If the send reports "is offline, message queued", report that faithfully to the user; don't pretend it was delivered.
- When you receive a broadcast prefixed `@all`, reply to the sender (`@from`), not to @all.
- One message, one point — it makes you easier to follow.

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

## 4. When to stop listening

- The user says stop, or the user sends a new instruction (**the user always comes first**).
- A peer's message says it's over ("done", "that's it for now").
- Two empty waits in a row (see above).

Principle: better to stop and ask the user than to burn tokens in an endless loop.
