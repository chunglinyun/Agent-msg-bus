# How an agent gets the bus context it needs

Status: **discussion record, nothing approved**. Split out of
`docs/multi-agent-efficiency-notes.md` item A, which is deferred (see below). That document keeps
the other half of the problem — what agents should *put* on the bus in the first place.

## Deferred: `msg log` over the ring buffer

The notes proposed `msg log -n 20`, reading the broker's existing 200-event ring
(`broker.js:81`, already built and already replayed to the web frontend). It is about ten lines
of code, and it is **not being built yet**, on purpose:

- **Volume.** 200 raw messages is a large, unfocused paste into an agent's context every time it
  wants to know one thing.
- **No precision.** The only filter is recency, and recency is not relevance. There is no way to
  ask for *the part that concerns me*.
- **Hallucination surface.** A wall of loosely-related chatter about other people's work is
  exactly the input that produces confident statements about things the agent only half-read.

The buffer itself stays as it is: the web frontend genuinely wants "everything, newest last".
What is deferred is exposing it to agents. Re-evaluate once messages are **selectable**
(idea 1) or **pre-digested** (idea 2) — at that point the same ten lines return something worth
reading.

## Idea 1: give every message a description, then select on it

Let the sender attach a small structured header so a reader can pick without reading bodies:

```
msg send @web-refactor --re auth-refactor --kind decision "cookie path stays /, see docs/auth-plan.md §3"
```

The broker stores those fields with the message; a future `log` filters on them
(`--re auth-refactor`, `--kind decision`, `--from x`) instead of returning the last N of
everything. The cost is a handful of tokens per send, paid once by the agent that has the context
to label correctly, and saved by every reader.

**The saving is not a smaller body — it is not opening the body at all.** A header that lets a
reader decide "not mine" without fetching anything is worth far more than any amount of
compression applied to the text it points at. Judge every variant of this idea by that test.

Open questions, none of them answered yet:

- **Who writes it, and is it enforced?** A field the skill merely *suggests* gets filled in
  inconsistently, which makes the filter untrustworthy — and an untrustworthy filter is worse
  than none, because the reader stops believing an empty result. A field the broker *requires*
  taxes every one-word message and will be worked around.
- **Fixed vocabulary or free text?** `--kind` only pays off if the set is tiny and stable
  (`decision` / `blocked` / `done` / `question`). Free text degenerates into per-agent dialects.
  `--re` is naturally free text, but only works if agents converge on the same string, which they
  will not do without a rule to anchor it — e.g. "use the plan document's filename".
- **Is the header enough on its own?** If a reader can act on headers alone and fetch bodies only
  on demand, this is a large win. If it always has to fetch the body anyway, we have added
  ceremony for nothing.

## Idea 2: don't store — summarize

The other direction: stop expecting the broker to be anyone's memory. Two shapes, and they are
not the same thing.

**2a. On-demand subtask.** An agent that needs context spawns a cheap subtask whose whole job is
to read the raw traffic and return five lines; the parent never pays for the raw form. The catch:
the subtask still has to read *something*, so this removes the buffer from the parent's context,
not from the system. Worth it only if the summarizer is genuinely cheap and the summary genuinely
short.

**2b. A scribe on the bus.** A dedicated session joins like any other member, receives `@all`
traffic as it happens, and maintains a rolling state summary — in its own context, or more
robustly in a file. Anyone who needs the picture asks the scribe (or reads the file) instead of
replaying history. **This needs zero broker changes**: a skill plus a running session, which
makes it the cheapest thing in this document to try. Its weaknesses are equally plain — one more
session to keep alive, it only sees what is broadcast (not DMs), and a summary is lossy in ways
nobody notices until it matters.

2b composes with idea 1 rather than competing with it: labelled messages make a scribe's job
nearly mechanical.

## Interaction with the other half

The content rules in `docs/multi-agent-efficiency-notes.md` (bus carries pointers, files carry
content) shrink this problem before any code is written: if bodies are one line plus a path, then
200 events is no longer an expensive paste, and "what happened" is answered by reading the
documents the messages point at. **Do that first and re-measure** — it may leave idea 1 as a
small refinement and idea 2 as unnecessary.

## What we would change if adopted

Nothing here is approved; this is the shape the work would take.

- `msg.js` — `--re` / `--kind` flags on `send`, and whatever `log` ends up being.
- `broker.js` — carry those fields through `send` into the ring buffer; filter on them in `log`.
- `msg-bus-skill/SKILL.md` + `AGENTS-template.md` — when to label, and the rule that anchors
  `--re` to a stable string.
- `README.md` — the protocol table, since the message shape changes.

## Not doing

Thread/topic routing inside the broker, priority queues, message IDs with relevance tracking,
persistent storage. Same as the notes document: nothing here should turn the broker into a
database.
