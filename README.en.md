# dsh-wazo-voice

Make a **DeepSeek Harness** session talk on the phone, through a
**Wazo / Asterisk** PBX, over AudioSocket, with local speech recognition and
synthesis.

> Version française : `README.md`.

## The need this module fills

Every existing solution that plugs an AI agent into a PBX assumes something we
do not have, or costs something we do not want to pay:

| What we need | Why the others do not give it |
|:--|:--|
| **Plain AudioSocket** | AVA makes it its main transport but also requires ARI/Stasis and only ships x86; AVR only publishes an amd64 binary core; Pipecat targets `chan_websocket`; LiveKit imposes SIP + WebRTC. |
| **Native ARM** | AVA and AVR are x86 only. On an Apple Silicon Mac, emulation skews latency and barge-in — precisely what one measures. |
| **The conversation is a real agent session** | AVA and AVR want to own the LLM: our agent would be plugged behind an OpenAI-compatible endpoint, losing control of its tools and memory. |
| **Everything local** | Whisper for recognition (port 9030) and Kokoro for synthesis (port 9032), no key and no cloud provider. |
| **Write and speak in the same conversation** | A reply typed during the call must be heard on the line: none of the compared solutions does this. |
| **Fill the thinking time** | Hold music while the agent searches, instead of silence. |

That combination is what no other project covers: a **thin AudioSocket**
bridge, **native ARM**, that **plugs in an already tool-equipped agent**
instead of reimplementing one, and **keeps the audio at home**.

## What it is not

- **No barge-in.** While the agent speaks, incoming audio is ignored (counted in
  `dropped`): you cannot interrupt it, and an utterance started during
  synthesis arrives truncated. That is the known, accepted limit, and the first
  piece of work if the module is to serve outside this context.
- **Not multi-PBX.** It targets the Wazo/Asterisk dialplan and its AudioSocket
  (`slin`, 8 kHz, 16-bit mono).
- **Not a framework.** No configurable pipeline, no interchangeable providers:
  three injected services (`asr`, `tts`, `agents`) and tools exposed to the
  agent.

## How it works

```
Asterisk ──AudioSocket──> VoiceBridge ──> CallSession (1 socket = 1 call)
                                             │  home-made VAD
                                             ├─> local ASR  (Whisper, 9030)
                                             ├─> AgentBridge ──> DSH session
                                             │      (tools, memory, preset)
                                             └─> local TTS  (Kokoro, 9032)
```

- `lib/bridge.js` listens on the AudioSocket ports, dials through AMI and
  exposes state.
- `lib/calls.js` frames 20 ms at protocol time, detects utterances, runs the
  turn, plays hold music and excerpts.
- `lib/agent.js` creates or resumes the call session, sets the spoken-language
  instruction, and picks up **written** replies so they are said on the line.
- `lib/hold-music.js` provides the hold loop: a supplied WAV, or a synthesized
  loop by default.

## Tools exposed to the agent

| Tool | Purpose |
|:--|:--|
| `wazo_voice_call` | Dials an extension or number through AMI. |
| `wazo_voice_say` | Says one sentence without going through the agent. |
| `wazo_voice_play` | Plays an excerpt of a WAV on the line. |
| `wazo_voice_hangup` | Hangs up after the goodbyes, without cutting the sentence in progress. |
| `wazo_voice_status` | Ports, current call, last call, ASR/TTS health, AMI secret. |
| `wazo_voice_configure` | Stores the AMI secret in the credential store. |

## Install

The module is a local bundle of the DSH profile:

```json
{ "dependencies": { "@local/dsh-wazo-voice": "link:/path/to/dsh-wazo-voice" },
  "dsh": { "profile": { "bundles": ["@local/dsh-wazo-voice"] } } }
```

Then, in the Wazo dialplan, call `AudioSocket(uuid,host:port)` towards one of
the listening ports.

## Configuration

Defaults live in `lib/config.js` and can be overridden by the `wazo-voice` row
of the profile:

| Key | Default | Meaning |
|:--|:--|:--|
| `ports` | `[8092, 8090]` | AudioSocket ports listened on. |
| `asr.url` | `http://127.0.0.1:9030/` | Local recognition. |
| `tts.url` | `http://127.0.0.1:9032/synthesize` | Local synthesis (Kokoro). |
| `ami.host` | `192.168.234.60` | PBX for outbound calls. |
| `holdMusic.file` | `''` | 16-bit mono 8 kHz PCM WAV; empty = synthesized loop. |
| `maxCallMs` | `1800000` | Guard against a forgotten call. |

## Tests

```sh
node --test test/*.test.mjs
```

## Licence

MIT (see `LICENSE`).

Audio excerpts are not versioned: see `assets/README.md`. The excerpt shipped
with Asterisk (FreePlay) stays reserved for PBX use and is not redistributable;
the public-domain recordings (Satie, Joplin) are.
