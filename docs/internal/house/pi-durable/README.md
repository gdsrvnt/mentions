---
description: How Pi Durable works and why it exists, as explained by Mario Zechner and Armin Ronacher on the 0xSero podcast.
source: https://youtu.be/ja_7AF54OtE
video_title: "Pi Durable: Agents That Survive Crashes — Mario Zechner & Armin Ronacher"
channel: 0xSero
video_date: 2026-10-07
speakers: [Mario Zechner, Armin Ronacher]
---

# Pi Durable

> As of 2026-10-07. This page is drawn only from what Mario Zechner and Armin Ronacher said in the video. The podcast host is not a source for anything here. Timestamps (`mm:ss`) point into [the video](https://youtu.be/ja_7AF54OtE).

## What it is

Pi Durable makes an agent survive the death of its process. Mario's definition: an agent starts in a process and calls tools, then the process dies. When the process restarts, the agent "continues exactly from where it left off" (`20:36`). Tool results and the rest of the agent's state are persisted and resumed from, with no human retyping anything.

This matters for long-running agents, which Mario called "anything that's a claw". It also has to work wherever agents run: Cloudflare Durable Objects, E2B, a laptop, a phone.

## The core idea: the effect sandwich

Pi Durable does not use event sourcing. Mario said that approach has "a lot of problems" (`22:28`). Instead, every side effect is wrapped in three steps, because a crash can happen before, during or after the effect.

1. **Record the intent.** Before running anything, store what's about to run and with which inputs. If the process dies here, the intent on restart shows the effect never ran, so it runs now.
2. **Run the effect idempotently.** A crash mid-effect leaves you not knowing whether it happened. Mario's example is starting a GitHub Actions run. The fix is to generate an ID, save it, and execute with it. If the run already exists, the external system says so and you wait for it. If it doesn't, it starts with that ID (`23:30`).
3. **Persist the result.** Once the result is stored, the intent record can be discarded, unless you want it for tracing. "I now have a result. That is all I wanted." (`24:48`)

Some effects can't be retried safely or undone, such as deleting a file or charging a card. Effects must be compatible with this scheme. Most external systems are. For the rest, you decide how to stub them (`25:20`).

## Architecture

Pi Durable has two primitives: **tasks** and **versioned documents**. Mario: "I can do a lot of shit with just this basic primitive" (`28:3x`).

**Tasks.** Everything that happens is a task, and every task is an effect sandwich (`25:50`). An LLM turn prepares the request (context, parameters, thinking level) and saves it. The model call is the effect, and the answer is saved after it. A tool call works the same way. Tasks can spawn other tasks.

**Versioned documents.** Application state, such as a to-do list or a canvas the agent draws on, lives in documents attached to positions in the transcript (`27:18`). When you rewind, sometimes you want the document as it was at that point and sometimes you want the latest version. The store supports both. "The document changes together with the agent."

**Change recording.** Mario looked at JSON Patch and found it lacking, so they designed a patch format optimized for agent workloads (`29:00`). The API is proxy-based. You get what looks like a plain JavaScript object, and assignments like `object.x = 10` are recorded as operations. Mario admits proxies are "basically a hack", and they come with some foot guns, "but it works really well for the things we need to do" (`30:35`).

Armin explained why this is hard at all. After about 20 years of web development, expressing changes to immutable, nested state still "didn't actually ever really get significantly better". Proxy-recording libraries like Immer are useful but "a huge hack … it has so many holes in it" (`29:30`).

## Why they built it

Mario said there was nothing general to build on. Hermes, OpenClaw and Amp's Orbs each solve durability inside their own harness, but "those are not general ones that I can take and then build the next … project on" (`32:00`). The aim was something small, about 12,000 lines, that handles an agent, compaction and the rest out of the box.

Armin was blunt that "you definitely don't need Pi Durable. You could totally build this yourself" (`32:54`). Their experience across several agent projects is that the hard part is making agents reliable: they recover from failure and keep going without a human babysitting them. That reliability "in itself is a lot of work". As agents become more orchestrated and more independent, Armin wants their orchestration to stay understandable, with "some level of sanity" (`33:08`).

It also took a while. Mario said Pi Durable "would have happened a lot earlier" if maintaining Pi hadn't consumed most of February through July (`03:03`).

## Dogfooding: Pi Mobile

Mario is testing Pi Durable through a phone app he calls Pi Mobile (`46:30`). Everything except the LLM runs on the phone. A remote machine, such as his Hetzner server, can act as the execution environment. It has replaced his use of Claude on Android. As of the video, it isn't planned as an open-source release.

## Where it's heading

Mario described Pi as a proof of concept for self-modifiable agentic software. The next step is many agents on many machines working with many humans, in whatever configuration people want (`46:50`). That needs a plugin system, and Mario said oh-my-pi is a conceptual inspiration for it.

Armin pointed at the hard part. The goal is for multiple people to share one session without fully trusting whoever hosts it (`48:56`). Isolating execution in containers is "almost trivial". The real problem is the web UI. A shared session where an agent can render interface is "literally XSS" waiting to steal someone's cookie. The usual fix, iframes, hurts the experience. "Making [an extensible] web that's also secure is way harder than it looks." (`49:26`)

## Related design views

These come up around Pi Durable and explain how the team builds:

- **Where humans stay in the loop.** Mario lets agents write whole layers of Pi, such as the TUI components, against an API he designed himself. He only steps in when performance regresses, because agents fix edge cases locally but don't fix architecture (`05:50`). Armin notes agents almost never fix a bug without adding code, so a fully automated codebase "is just naturally going to grow" (`04:43`).
- **Why models stay weak at architecture.** Mario said there's little training data for "the process of … designing and architecting something" (`16:06`). Armin's example is Pi Durable itself, which went through many iterations. Nothing in the traces marks which one shipped (`17:32`).
- **MCP and code mode.** Armin said MCP landed in Pi because he needed code mode to drive the Jev classifier. MCP itself took "like five minutes" (`38:52`). Mario said MCP support came after "a year … of deliberation", and that changing their mind on new information is the point (`52:09`).

## Caveats

These notes come from a machine transcript with automatic speaker labels. Timestamps marked `x` are approximate. A few stretches are uncertain or were left out: `15:42`–`16:06`, `18:00`, `19:24` and `52:55`–`54:12` have uncertain speakers, and `20:36`–`21:57` and `26:46`–`27:18` are partly unreadable.
