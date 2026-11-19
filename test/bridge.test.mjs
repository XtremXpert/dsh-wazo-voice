import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { FrameParser, KIND, encodeFrame } from '../lib/audio.js'
import { VoiceBridge } from '../lib/bridge.js'
import { resolveConfig } from '../lib/config.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

function tone(samples, amplitude = 6000, sampleRate = 8000) {
  const buffer = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * index) / sampleRate)), index * 2)
  }
  return buffer
}

const silence = (ms) => Buffer.alloc((ms * 8000 * 2) / 1000)

function framesOf(pcm, size = 320) {
  const frames = []
  for (let offset = 0; offset < pcm.length; offset += size) {
    frames.push(encodeFrame(KIND.AUDIO, pcm.subarray(offset, Math.min(offset + size, pcm.length))))
  }
  return frames
}

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`délai dépassé: ${label}`)
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket))
    socket.once('error', reject)
  })
}

/** Pont de test sur un port éphémère, avec des services pilotés. */
async function bridgeWith({ services, config = {}, ami } = {}) {
  const resolved = resolveConfig({ ports: [0], ...config })
  const bridge = new VoiceBridge({
    config: resolved,
    logger: silent,
    services,
    resolveSecret: async () => ({ value: 's3cret', source: 'test' }),
    ...(ami ? { ami } : {}),
  })
  const listening = await bridge.start()
  return { bridge, port: listening[0].port }
}

test('un énoncé entrant devient une réponse parlée', async () => {
  const transcribed = []
  const asked = []
  const spoken = []
  const { bridge, port } = await bridgeWith({
    services: {
      asr: {
        async transcribe(pcm) {
          transcribed.push(pcm.length)
          return { text: 'Quelle heure est-il ?', seconds: 1 }
        },
      },
      agents: {
        async ask(text) {
          asked.push(text)
          return 'Il est midi et quart.'
        },
      },
      tts: {
        async synthesize(text) {
          spoken.push(text)
          return { pcm: tone(1600), source: 'test', sampleRate: 8000 }
        },
      },
    },
  })
  try {
    const socket = await connect(port)
    const parser = new FrameParser()
    const inbound = []
    socket.on('data', (chunk) => inbound.push(...parser.push(chunk)))

    socket.write(encodeFrame(KIND.UUID, Buffer.alloc(16, 3)))
    for (const frame of framesOf(tone(1600))) socket.write(frame)
    for (const frame of framesOf(silence(700))) socket.write(frame)

    await waitFor(() => inbound.filter((frame) => frame.kind === KIND.AUDIO).length >= 10, 8000, 'audio de réponse')
    assert.deepEqual(asked, ['Quelle heure est-il ?'])
    assert.deepEqual(spoken, ['Il est midi et quart.'])
    assert.ok(transcribed[0] > 1600, 'la transcription reçoit la parole et sa queue de silence')

    const active = bridge.status().active
    assert.equal(active.length, 1)
    assert.equal(active[0].direction, 'inbound')
    assert.equal(active[0].stats.turns, 1)

    socket.write(encodeFrame(KIND.HANGUP))
    await waitFor(() => bridge.calls.length === 0, 3000, 'fin de l’appel')
    const last = bridge.status().last
    assert.equal(last.state, 'ended')
    assert.match(last.endedReason, /raccroché/)
    socket.destroy()
  } finally {
    await bridge.stop()
  }
})

test('l’accueil entrant est prononcé dès la connexion', async () => {
  const spoken = []
  const { bridge, port } = await bridgeWith({
    config: { greet: { inbound: 'Bonjour, je vous écoute.', outbound: '' } },
    services: {
      asr: { async transcribe() { return { text: '', seconds: 0 } } },
      agents: { async ask() { return 'jamais' } },
      tts: {
        async synthesize(text) {
          spoken.push(text)
          return { pcm: tone(320), source: 'test', sampleRate: 8000 }
        },
      },
    },
  })
  try {
    const socket = await connect(port)
    const parser = new FrameParser()
    const inbound = []
    socket.on('data', (chunk) => inbound.push(...parser.push(chunk)))
    socket.write(encodeFrame(KIND.UUID, Buffer.alloc(16, 1)))
    await waitFor(() => inbound.some((frame) => frame.kind === KIND.AUDIO), 3000, 'accueil')
    assert.deepEqual(spoken, ['Bonjour, je vous écoute.'])
    socket.destroy()
  } finally {
    await bridge.stop()
  }
})

test('un appel sortant compose par AMI et est reconnu comme sortant', async () => {
  const originated = []
  const spoken = []
  const { bridge, port } = await bridgeWith({
    config: { ami: { host: '127.0.0.1', advertiseHost: '127.0.0.1' } },
    ami: {
      async originateCall(config, secret, options) {
        originated.push({ config, secret, options })
        return { fields: { Response: 'Success', ActionID: '42' }, channel: options.channel }
      },
    },
    services: {
      asr: { async transcribe() { return { text: '', seconds: 0 } } },
      agents: { async ask() { return '' } },
      tts: {
        async synthesize(text) {
          spoken.push(text)
          return { pcm: tone(320), source: 'test', sampleRate: 8000 }
        },
      },
    },
  })
  try {
    const result = await bridge.call({ to: '1000' })
    assert.equal(result.channel, 'PJSIP/1000')
    assert.equal(originated[0].secret, 's3cret')
    assert.equal(originated[0].options.channel, 'PJSIP/1000')
    assert.equal(originated[0].options.application, 'AudioSocket')
    assert.match(originated[0].options.data, new RegExp(`^[0-9a-f-]{36},127\\.0\\.0\\.1:${port}$`))
    assert.equal(bridge.status().active.length, 0, 'aucun appel avant le décrochage')

    const socket = await connect(port)
    const parser = new FrameParser()
    const inbound = []
    socket.on('data', (chunk) => inbound.push(...parser.push(chunk)))
    socket.write(encodeFrame(KIND.UUID, Buffer.alloc(16, 2)))
    await waitFor(() => bridge.status().active.length === 1, 3000, 'connexion AudioSocket')
    assert.equal(bridge.status().active[0].direction, 'outbound')
    await waitFor(() => inbound.some((frame) => frame.kind === KIND.AUDIO), 3000, 'accueil sortant')
    assert.match(spoken[0], /Bonjour/)
    assert.equal(bridge.hangup(), 1)
    await waitFor(() => bridge.calls.length === 0, 3000, 'raccrochage après l’accueil')
    socket.destroy()
  } finally {
    await bridge.stop()
  }
})

test('un appel sortant sans secret est refusé avec un message actionnable', async () => {
  const bridge = new VoiceBridge({
    config: resolveConfig({ ports: [0] }),
    logger: silent,
    services: { asr: {}, tts: {}, agents: {} },
    resolveSecret: async () => undefined,
  })
  await assert.rejects(bridge.call({ to: '1000' }), /secret AMI absent/)
  await bridge.stop()
})

test('un raccrochage demandé pendant le tour attend la fin de la phrase', async () => {
  let bridge
  const started = await bridgeWith({
    services: {
      asr: { async transcribe() { return { text: 'Au revoir.', seconds: 1 } } },
      agents: {
        async ask() {
          const requested = bridge.hangup()
          assert.equal(requested, 1)
          return 'Bonne journée.'
        },
      },
      tts: { async synthesize() { return { pcm: tone(1600), source: 'test', sampleRate: 8000 } } },
    },
  })
  bridge = started.bridge
  try {
    const socket = await connect(started.port)
    const parser = new FrameParser()
    const inbound = []
    socket.on('data', (chunk) => inbound.push(...parser.push(chunk)))
    socket.write(encodeFrame(KIND.UUID, Buffer.alloc(16, 1)))
    for (const frame of [...framesOf(tone(1600)), ...framesOf(silence(700))]) socket.write(frame)
    await waitFor(() => inbound.filter((frame) => frame.kind === KIND.AUDIO).length >= 10, 8000, 'phrase d’adieu')
    await waitFor(() => bridge.calls.length === 0, 3000, 'raccrochage après la phrase')
    assert.match(bridge.status().last.endedReason, /raccroché par l’agent/)
    socket.destroy()
  } finally {
    await bridge.stop()
  }
})

test('un énoncé de trop remplace le plus ancien en attente', async () => {
  let resolveReply
  const { bridge, port } = await bridgeWith({
    config: { maxQueuedTurns: 1 },
    services: {
      asr: { async transcribe() { return { text: 'Une question', seconds: 1 } } },
      agents: { ask: () => new Promise((resolve) => { resolveReply = resolve }) },
      tts: { async synthesize() { return { pcm: tone(320), source: 'test', sampleRate: 8000 } } },
    },
  })
  try {
    const socket = await connect(port)
    socket.write(encodeFrame(KIND.UUID, Buffer.alloc(16, 1)))
    const frames = [...framesOf(tone(1600)), ...framesOf(silence(700))]
    for (const frame of frames) socket.write(frame)
    await waitFor(() => resolveReply !== undefined, 5000, 'premier tour')
    // Deux énoncés de plus pendant que l'agent réfléchit, avec une seule place
    // en attente : le plus ancien cède la place au plus récent.
    for (let index = 0; index < 2; index += 1) {
      for (const frame of [...framesOf(tone(1600)), ...framesOf(silence(700))]) socket.write(frame)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    const call = bridge.status().active[0]
    assert.ok(call.stats.dropped > 0, 'le remplacement est compté')
    assert.equal(call.pending, 1, 'une seule question attend son tour')
    resolveReply('Voilà.')
    socket.destroy()
  } finally {
    await bridge.stop()
  }
})
