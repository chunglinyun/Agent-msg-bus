---
name: ask-peer
description: Synchronously delegate one simple, self-contained (stateless, one-shot) task to the other Claude Code instance (work and personal, either direction) and get the result straight back. Good for a single question, looking something up, or running a one-off pass — anything that needs no memory across calls. Trigger when the user says "have personal look up / summarise…" or "ask work to check…" and the task can be finished in one go. For collaboration that needs continuous context, several rounds of back-and-forth, or a peer that stays alive, use the message channel (msg send/recv) instead of this skill.
---

# ask-peer: synchronous delegation to the other instance

## When to use it (important)

**Use this skill (bash / `claude -p`) — simple, self-contained tasks:**
things finishable in one go that need no memory of what was said before. For example:
"have personal look up TT-1720 and summarise it", "ask personal whether this file has problems".
Characteristics: synchronous (result comes straight back), stateless (a brand-new one-shot agent
each time), no need to coordinate send/receive timing.

**Don't use this skill, use the message channel — continuous, multi-turn collaboration:**
when the peer must remember context, when you'll go back and forth several times, or when you want
the peer to be a long-lived presence. Then use `node "$CLAUDE_MSG" send <peer> "…"` and
`node "$CLAUDE_MSG" recv --wait N`.

The one-line test: **"say it once, they do it, they answer, done" → bash; "talk while working, remember the backstory" → channel.**

## How

Run this in your Bash tool (peer is `work` or `personal`, i.e. the other side):

```bash
node "C:\Users\g3197\.claude-split\bin\askpeer.js" personal "look up TT-1720 and summarise: 1) title and purpose 2) requirements 3) acceptance criteria"
```

It opens a one-shot `claude -p` under the peer's fake home and streams that agent's output back
**synchronously**. Once you have the result, summarise the key points for the user.

## Notes

- This is a **stateless** call: the peer won't remember your previous question. If context is needed, put it all in the prompt, or switch to the channel.
- The peer runs under its own fake home (account/settings), so the tools and logins it sees are that home's.
- A timeout, or a peer that isn't installed properly, produces a non-zero exit code and an error message; troubleshoot from that message.
