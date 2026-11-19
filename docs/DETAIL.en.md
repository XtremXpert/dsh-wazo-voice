# Wazo voice

A real voice conversation between a human on the phone and the Harness agent,
over a **Wazo** PBX. The plugin carries both media directions: it listens
(speech recognition), it speaks (synthesis), and **the agent session** is what
answers — not an HTTP façade.

> Version française : `docs/DETAIL.md`.

## How a call arrives

```
extension 1000 ──► Wazo (dialplan) ──► AudioSocket ──► this plugin
                                                            │
                                        recognition (local ASR) │
                                                            ▼
                                                   dedicated agent session
                                                            │
                                           synthesis (local TTS) │
                                                            ▼
extension 1000 ◄── Wazo ◄── 20 ms PCM frames ◄─────────────────┘
```

- **Inbound**: dial the extension wired to `AudioSocket(uuid, host:port)` in the
  Wazo dialplan (extension `1099` in the Maison internal context). The greeting
  is optional (`greet.inbound`).
- **Outbound**: `wazo_voice_call` dials through **AMI** and runs the
  `AudioSocket` application **on the dialled channel**: Asterisk rings the
  extension and, on answer, opens the AudioSocket straight to this plugin. One
  channel, no dialplan context to know about. The `opening` sentence is spoken
  as soon as the call is answered.

The plugin listens on **two ports** by default (8092 and 8090) because the
deployed dialplan used one and then the other. A busy port is reported; the
other keeps listening.

## What the call lets you hear

- **Hold music** while the agent thinks, from the start of the turn until the
  first frame of the reply. The loop comes from `holdMusic.file` (16-bit mono
  8 kHz PCM WAV) or, failing that, from a synthesized loop with no dependency.
  It stops dead: never overlapping the voice.
- **Written replies**: a reply typed in the call conversation is also spoken on
  the line, with markdown cleaned up before synthesis. Agent and human keep the
  same thread, in text and in voice.
- **Audio excerpts**: `wazo_voice_play` plays a WAV (music, ambience) on the
  line, without going through synthesis.

## Tools exposed to the agent

| Tool | Purpose |
|---|---|
| `wazo_voice_call` | Dials an extension (`to`, `opening`) and speaks to whoever answers. |
| `wazo_voice_status` | Listening ports, current call, last call, ASR/TTS availability, AMI secret presence. |
| `wazo_voice_say` | Says one sentence on the current call, outside the agent turn. |
| `wazo_voice_play` | Plays an excerpt of a WAV on the line (`file`, `seconds`). |
| `wazo_voice_hangup` | Hangs up the current call, after the sentence in progress. |
| `wazo_voice_configure` | Stores the AMI secret in the credential store (never in the config). |

The call session is **dedicated** (`agent.sessionId`, default `wazo-voice`): a
phone call does not divert the working conversation. It borrows the preset of
the agent that placed the call, and receives a spoken-language instruction
(short sentences, no markdown) set on its own context.

## Prerequisites

1. **Wazo** reachable from the Harness host, with an extension in the dialplan
   that calls `AudioSocket(${UUID()}, <host-ip>:<port>)` then `Hangup()`.
2. **Recognition**: a local service (default `http://127.0.0.1:9030/`), contract
   `POST /?language=fr` with raw 8 kHz mono int16-LE PCM, reply
   `{ "text": … }`.
3. **Synthesis**: a local service (default `http://127.0.0.1:9032/synthesize`),
   `{ text, voice, speed }` → `audio/wav`, resampled to 8 kHz by the plugin.
   Fallback to `say` + `afconvert` (macOS) when Kokoro does not answer.
4. **AMI** (outbound calls only): an AMI user on the PBX. Its secret is stored
   with `wazo_voice_configure`, or through the environment variable named by
   `ami.secretRef` (default `WAZO_AMI_SECRET`). The address the PBX must reach
   is detected from the route to `ami.host`; `ami.advertiseHost` pins it when
   detection does not fit.

## Settings

Configuration is read from the `wazo-voice` row of the profile
(`~/.dsh/profiles/desktop/cordis.patch.yml`). The package imposes no schema:
defaults live in `lib/config.js`, and only differences need to be written.

```yaml
- id: wazo-voice
  name: '@local/dsh-wazo-voice'
  config:
    ports: [8092]
    asr: { url: 'http://127.0.0.1:9030/', language: 'fr' }
    tts: { voice: 'ff_siwis' }
    holdMusic:
      file: /path/to/hold.wav
    ami:
      host: 192.168.234.60
      user: dsh
      channelTemplate: 'PJSIP/{to}'
      # context/exten only apply when application is '' (legacy form).
```

## Known limits

- **No barge-in**: while the agent speaks, incoming audio is ignored (counted
  in `dropped`) so that synthesis is not transcribed. Talking over the reply is
  therefore lost, and an utterance started during synthesis arrives truncated —
  which is why transcripts are sometimes wrong. Waiting for the end of the
  agent's sentence is the right way to speak. This is the first piece of work
  if the module is to serve outside this context.
- **Live audio wins**: while hold music plays, incoming audio is still captured
  and queued; an utterance that is too long during thinking can exceed
  `maxQueuedTurns` and be replaced by the most recent one.
- **Hang-up**: the agent must call `wazo_voice_hangup`; otherwise the line stays
  open until the human hangs up. A hang-up requested during a turn waits for the
  sentence in progress.
- **One line at a time**: a single active call; `wazo_voice_call` refuses while
  a call is up.
- **Latency**: the turn is sequential (end of utterance → recognition → agent →
  synthesis). A reply that calls tools takes as long as the tools; hold music
  and `wazo_voice_say` fill the wait.
- **8 kHz**: telephone bandwidth; recognition and synthesis keep that quality,
  with no bundled model.
- **`Originate` is not an answer**: the AMI reply proves queueing. Proof of
  answer is the AudioSocket connection, visible in `wazo_voice_status`
  (`active`).
- **No transfer, hold or DTMF**: out of scope.
- **One PBX**: the channel (`PJSIP/{to}`), the AMI user and the advertised
  address come from configuration, not from discovery.

## Verification

`node --test test/*.test.mjs` covers 40 cases: fragmented AudioSocket framing,
speech detection, 24 kHz → 8 kHz resampling, the AMI client against a simulated
server, hold music (loop, levels, WAV reading), and a **full round trip**
(synthetic AudioSocket client → ASR → agent → synthesis → 20 ms frames),
inbound and outbound.

A real call depends on the PBX and a handset: it is verified in the field, not
in a unit test.
