import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KIND,
  FrameParser,
  SpeechDetector,
  decodeWav,
  encodeFrame,
  msToBytes,
  resampleMono16,
  rms16,
  silencePcm,
  toMono16,
} from '../lib/audio.js'

/** Échantillon int16 sinusoïdal à l'amplitude demandée. */
function tone(samples, amplitude = 4000, sampleRate = 8000) {
  const buffer = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * index) / sampleRate)), index * 2)
  }
  return buffer
}

/** WAV PCM 16 bits minimal. */
function wav(samples, { sampleRate = 16000, channels = 1 } = {}) {
  const data = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) data.writeInt16LE(samples[index], index * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

test('encodeFrame écrit type et longueur big-endian', () => {
  const frame = encodeFrame(KIND.AUDIO, Buffer.from([1, 2, 3]))
  assert.equal(frame[0], 0x10)
  assert.equal(frame.readUInt16BE(1), 3)
  assert.deepEqual([...frame.subarray(3)], [1, 2, 3])
})

test('encodeFrame refuse une charge de plus de 65535 octets', () => {
  assert.throws(() => encodeFrame(KIND.AUDIO, Buffer.alloc(70000)), /trop longue/)
})

test('FrameParser recompose des trames fragmentées et multiples', () => {
  const parser = new FrameParser()
  const one = encodeFrame(KIND.UUID, Buffer.alloc(16, 7))
  const two = encodeFrame(KIND.AUDIO, Buffer.from([9, 9]))
  const stream = Buffer.concat([one, two])
  assert.deepEqual(parser.push(stream.subarray(0, 5)), [], 'trame incomplète gardée')
  const frames = parser.push(stream.subarray(5))
  assert.equal(frames.length, 2)
  assert.equal(frames[0].kind, KIND.UUID)
  assert.equal(frames[0].payload.length, 16)
  assert.equal(frames[1].kind, KIND.AUDIO)
  assert.deepEqual([...frames[1].payload], [9, 9])
  assert.equal(parser.pending, 0)
})

test('FrameParser attend la charge complète', () => {
  const parser = new FrameParser()
  const frame = encodeFrame(KIND.AUDIO, Buffer.alloc(320, 1))
  assert.deepEqual(parser.push(frame.subarray(0, 200)), [])
  assert.equal(parser.pending, 200)
  assert.equal(parser.push(frame.subarray(200)).length, 1)
})

test('rms16 mesure le silence et le signal', () => {
  assert.equal(rms16(Buffer.alloc(320)), 0)
  assert.ok(rms16(tone(160, 4000)) > 2000)
})

test('SpeechDetector ferme un énoncé après le silence', () => {
  const detector = new SpeechDetector({ threshold: 450, endSilenceMs: 200, minSpeechMs: 100, preRollMs: 100 })
  const utterances = []
  for (let index = 0; index < 10; index += 1) utterances.push(...detector.push(tone(160)))
  assert.equal(utterances.length, 0, 'parole en cours')
  for (let index = 0; index < 10; index += 1) utterances.push(...detector.push(silencePcm(20)))
  assert.equal(utterances.length, 1)
  assert.ok(utterances[0].length > msToBytes(100), 'pré-roll et parole conservés')
})

test('SpeechDetector ignore un bruit trop court', () => {
  const detector = new SpeechDetector({ threshold: 450, endSilenceMs: 100, minSpeechMs: 300 })
  detector.push(tone(160, 4000))
  const utterances = []
  for (let index = 0; index < 10; index += 1) utterances.push(...detector.push(silencePcm(20)))
  assert.equal(utterances.length, 0)
})

test('SpeechDetector coupe un énoncé trop long', () => {
  const detector = new SpeechDetector({ threshold: 450, endSilenceMs: 1000, minSpeechMs: 100, maxUtteranceMs: 200 })
  const utterances = []
  for (let index = 0; index < 10 && utterances.length === 0; index += 1) utterances.push(...detector.push(tone(160, 6000)))
  assert.equal(utterances.length, 1)
})

test('SpeechDetector recadre après reset (bascule en synthèse)', () => {
  const detector = new SpeechDetector({ threshold: 450, endSilenceMs: 100, minSpeechMs: 50 })
  detector.push(tone(160, 6000))
  detector.reset()
  assert.equal(detector.speaking, false)
})

test('decodeWav lit les chunks dans le désordre', () => {
  const source = wav([1, -1, 2, -2], { sampleRate: 24000 })
  // Déplace le chunk data avant fmt pour vérifier la lecture par identifiant.
  const fmt = source.subarray(12, 36)
  const data = source.subarray(36)
  const reordered = Buffer.concat([Buffer.from('RIFF'), source.subarray(4, 8), Buffer.from('WAVE'), data, fmt])
  assert.equal(reordered.readUInt32LE(4), source.readUInt32LE(4))
  const decoded = decodeWav(source)
  assert.equal(decoded.sampleRate, 24000)
  assert.equal(decoded.channels, 1)
  assert.equal(decoded.bitsPerSample, 16)
  assert.equal(decoded.data.length, 8)
  assert.equal(decodeWav(reordered).sampleRate, 24000)
})

test('decodeWav refuse un tampon qui n’est pas du WAV', () => {
  assert.throws(() => decodeWav(Buffer.from('not a wav')), /WAV invalide/)
})

test('toMono16 moyenne les canaux stéréo', () => {
  const data = Buffer.alloc(8)
  data.writeInt16LE(100, 0)
  data.writeInt16LE(300, 2)
  data.writeInt16LE(-100, 4)
  data.writeInt16LE(-300, 6)
  const mono = toMono16(data, 2, 16)
  assert.equal(mono.length, 4)
  assert.equal(mono.readInt16LE(0), 200)
  assert.equal(mono.readInt16LE(2), -200)
})

test('resampleMono16 réduit 24 kHz en 8 kHz au bon nombre d’échantillons', () => {
  const input = tone(2400, 1000, 24000)
  const output = resampleMono16(input, 24000, 8000)
  assert.equal(output.length, 800 * 2)
})

test('resampleMono16 ne touche pas une fréquence identique', () => {
  const input = tone(160)
  assert.equal(resampleMono16(input, 8000, 8000), input)
})

test('silencePcm produit 20 ms pour le canal 8 kHz', () => {
  assert.equal(silencePcm(20).length, 320)
})
