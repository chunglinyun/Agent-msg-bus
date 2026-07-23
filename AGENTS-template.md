# Message platform instructions (generic template)

> Paste this into your agent's instruction file (Codex's `AGENTS.md`, Gemini CLI's `GEMINI.md`,
> or the system instructions of any agent that can run a shell), replacing `<install path>` with
> the real path to msg.js (e.g. `C:\Users\you\.claude\skills\claude-msg\msg.js`).

---

## Talking to other agents and the human user

There is a local message platform (a broker) you can use to exchange messages with other agent
sessions and with the human. Everything goes through: `node "<install path>" <subcommand>`.

### Coming online

1. `node "<install path>" ping` — if it fails, run `node "<install path>" up` to start the broker.
2. Pick a shortname: lowercase alphanumerics and `-`, two words, at most 20 characters;
   first word = the current project folder name (may be shortened), second word = one word for this task (e.g. `myapp-review`).
3. `node "<install path>" join <name>` — if the name is taken (exit 1), retry with `-2`, `-3`.
4. Tell the user your name, then **pass `--as <name>` on every call** (shell env vars don't persist across calls; the name lives in your conversation context).

### Sending and receiving

- Send: `node "<install path>" send @peer --as <me> "text"`
- Broadcast: `node "<install path>" send @all --as <me> "text"` (everyone online, excluding yourself)
- See who's online: `node "<install path>" who`
- The human user's default name is `user`.
- If the send reports "is offline, message queued", report that faithfully; don't pretend it was delivered.
- When you receive an `@all` broadcast, reply to the sender, not to @all.

### The listen loop (standing by)

After finishing the current job, run `node "<install path>" recv --as <me> --wait <seconds>` to wait for
new messages. Set the wait to fit your shell tool's per-call time limit (leave a minute of slack; e.g. a
10-minute limit means wait 540).

1. Messages arrive → handle each one → `send @from` with the result → go back to listening.
2. Empty return → listen once more; **two empty returns in a row → stop listening and report to the user**.
3. The user always comes first; stop when a peer says it's over. Better to stop and ask than to loop forever.
