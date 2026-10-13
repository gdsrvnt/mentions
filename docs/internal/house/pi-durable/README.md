---
description: Study notes on Pi Durable, drawn only from what Mario Zechner and Armin Ronacher said on the 0xSero podcast.
source: https://youtu.be/ja_7AF54OtE
video_title: "Pi Durable: Agents That Survive Crashes — Mario Zechner & Armin Ronacher"
channel: 0xSero
video_date: 2026-10-07
speakers: [Mario Zechner, Armin Ronacher]
---

# pi-durable: study notes

Everything below is as of **2026-10-07**, the upload date of the video. The notes use only what Mario and Armin said. Nothing the host said is included: no questions, no framing, no paraphrases. Each quote carries a `mm:ss` timestamp into the video. Quotes come from a machine transcript, with transcription junk trimmed and marked `…`. Full Mario and Armin excerpts are in [transcript.md](transcript.md).

## 1. What durability means

- **Mario** gave a five-sentence definition. An agent starts in a process and calls tools. The process dies. The process restarts and the agent "continues exactly from where it left off". Tool results and the rest of its state are "persisted durably and reliably resumed from". `20:36`
  > "Agent starts off in a process. Agent calls tools. Process dies. What you want is restart the process and agent continues exactly from where it left off, that is durability" `20:36`
- **Mario** said it's needed for long-running agents, "anything that's a claw". `20:36`
- **Mario** said it runs in "a lot of places". The transcript of that line is garbled. It names Cloudflare Durable Objects, E2B, "your laptop, my phone". `21:5x` (low-confidence segment)

## 2. The effect sandwich

- **Mario** said Pi Durable does **not** use event sourcing: "we don't do event sourcing … and we don't do that because there are a lot of problems". `22:28`
- **Mario** said execution can break before, during or after an effect. `22:42`
  1. **Before:** store the intent first: "I'm about to [run] this thing with these parameters". After a crash, the stored intent shows it hadn't run yet, so you run it. `22:42`
  2. **During:** with an external system such as a GitHub Actions run, you can't know whether it executed. The fix is to generate and save an ID before executing, then execute with that ID. "if [it] already runs GitHub tells me it's already running … If it's not running yet, it will start that run with that ID". That is idempotency. `23:30`
  3. **After:** "I get a result back and I … store it". You can then discard the intent info unless you need it for traces or logging. "the important [thing is] I now have a result. That is all I wanted." `24:48`
- **Armin** teased Mario about the word: "Your favorite word, item[potency]". `24:45`
- **Mario** said some effects can't be undone or safely retried, such as deleting a file on disk or charging a credit card, which you don't want "twice". Effects need to be "combinable with this durability system". Most external things are. For the rest, "you have to decide how [to] stub that". `25:20`

## 3. Architecture: tasks and versioned documents

- **Mario:** "basically everything that happens is a task that is just this effect sandwich". `25:50`
  - LLM call: prepare the request (context, parameters, thinking level), save it, then the LLM call is the effect, then save the answer.
  - Tool call: the same, as a task that executes the tool call from the LLM. `26:20`
- **Mario** said one task can spawn others. Part of this stretch is missing from the transcript, roughly 26:46 to 27:18. `27:18`
- **Mario** on **versioned documents**: a document such as a to-do list changes over the transcript. When you go back in time, "sometimes you want that version at that time … other times i just want the latest version of the document". The document store supports both kinds, attached to any position in the transcript. `27:18`
  - Example: a canvas drawing the agent edits. "The document changes together with the agent. If I go back in time, I want to have the old version of that drawing". `27:18`
  > "I can do a lot of shit with just this basic primitive of version documents and tasks." `28:3x`
- **Mario:** he looked at JSON Patch (an RFC), "found it to be lacking for this so we came up with something … optimized for the agentic stuff". `29:00`
- **Mario** said the API is a proxy. You ask storage for a document and get what "looks like a javascript object". Writing `object.x = 10` "gets automatically recorded as an operation". He called proxies "basically a hack … but it works really well for the things we need to do", and said "there's obviously also some foot guns". `30:35`
- **Armin**, for context: after about 20 years of web development, he's surprised the problem of expressing state changes on immutable data "didn't actually ever really get significantly better". He said Immer-style proxies that record changes are "like a huge hack … it has so many holes in it". `29:30`, `29:57`

## 4. Why build it

- **Mario:** "There wasn't much out there". Hermes, OpenClaw, other claws and Amp Orbs each solve durability "for the agent harness specifically", but "those are not general ones that I can take and then build the next … project on". `32:00`
- **Mario:** the goal was something "very small, it's only like 12,000 lines of [code]". It should be generic enough to handle an agent, compaction "and all the other shit" out of the box. `32:00`
- **Armin:** "you definitely don't need Pi Durable. You could totally build this yourself". `32:54`
- **Armin:** across several agent projects, the hard part was making agents reliable and able to recover from failure "even if the human is not like babysitting". "making it like reliable and a thing that you … want to build on, that actually in itself is a lot of work." `33:08`
- **Armin:** as agents get more orchestrated and run independently of humans, and they're "unreliable enough" already, you want the orchestration to be understandable, with "some level of sanity". `33:41`
- **Mario:** "Pi durable would have happened a lot earlier" if he hadn't spent February to July mostly maintaining Pi, triaging and fixing issues. `03:03`

## 5. Dogfooding: Pi Mobile

- **Mario** is building a phone-first app he calls Pi Mobile ("PIM"), "to ensure that PI durable actually works". He said it isn't planned as an open-source product "at the moment". `46:30`
- **Mario:** "PIM works entirely on my phone except for the LLM". It can use a remote machine, such as his Hetzner box, as the execution environment "while the brain [is on the] phone". It replaced his use of Claude on Android. `47:20`

## 6. Where Pi goes next

- **Mario:** "Pi is an initial proof of concept for self-modifiable agentic software". Next it should move toward "many [agents] on many machines talking to many humans", in "whatever configuration" of agents and humans. `46:50`
- **Mario:** next comes a plugin system. oh-my-pi is a conceptual inspiration, "not necessarily on a technical level". `47:50`, `43:18`
- **Armin:** "There's a surprising amount of complexity in a plug-in system for web". Making it secure "makes the experience shit". `48:10`
- **Armin:** "the goal should really be that multiple people can experience one session together". The catch is not having to "fully trust the home session you're connecting" to. `48:56`
- **Armin:** containers are "almost trivial". The hard part is the web UI: shared sessions where an agent "brings up some user interface that is literally XSS to like exfiltrate my cookie". The usual fixes are iframes, "which suck for user experience". "making [an extensible] web that's also secure is way harder than it looks." `49:26`
- **Mario:** "We're going to find out." `50:24`

## 7. Agents, slop and architecture (context for the design)

- **Mario:** lots of Pi is "pure slop", by design. It depends on which layer gets a human. He designed the TUI core himself (early 2025). He then had the agent write the markdown, text and other components against that API without reading their code: "The only time I do care is if performance goes down". `05:50`
- **Mario:** agents are good at finding problems but bad at general solutions. They fix edge cases locally and don't "identify issues in the architecture itself". `07:00`
- **Armin:** an agent "will definitely solve the problem, but it's almost [impossible that it fixes one without adding code]". "If you have a fully automated code base, I think it's just naturally going to grow with every single bug fix." `04:10`, `04:43`
- **Armin:** newer models feel "a little bit worse … in the outcome" because he gives them "way more control" and trusts them more. `08:12`
- **Mario:** there is no training data for "the process of building, of designing and architecting something … that's why we are stuck here". `16:06`
- **Armin:** Pi Durable itself went through multiple iterations. How would training know which conversation "ultimately [was] the version that we shipped?" `17:32`
- **Mario/Armin:** LLMs shine where there's an oracle and fuzzing. Armin had an LLM implement many formats for his serialization library from example files, then "fuzz the hell out of it", and it found many issues. `13:30`, `14:23`

## 8. MCP, code mode and the Jev classifier

- **Armin:** "MCP landed in Pi" because he "needed code mode for [Jev]". MCP itself was "like five minutes". A classifier model "needs another … system to generate like a bespoke [harness] around it". `38:52`
- **Armin:** many tasks are "fundamentally very squishy … they need LLMs, but they're too slow". Well-trained classifiers are "a different category of model". `39:20`
- **Mario:** "it took us a year to add support for [MCP] after excruciating … deliberation". "i change my mind if new information is available". `52:09`

## Uncertain attributions

- `15:42`–`16:06`: the turns flip several times between Mario and Armin. Who said "I think that models are actually … pretty good at it" is uncertain.
- `18:00`: "This is basically a classification problem…" (trace classification) is diarized as Mario. Armin is the one working on classifiers, so this could be his.
- `19:24`: the RSI and self-improvement remark is diarized as Armin. Low confidence.
- `32:54`–`33:41`: diarized as Armin throughout, with one stray Mario fragment.
- `52:55`–`54:12`: Armin and Mario overlap. Not used.
- `20:36`–`21:57` and `26:46`–`27:18`: the transcript is corrupt or missing. Only the clean parts are quoted.
