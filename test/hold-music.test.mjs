import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FRAME_BYTES } from '../lib/audio.js'
import { holdMusicPcm, readWavPcm16, synthesizedPcm } from '../lib/hold-music.js'

function peakOf(pcm) {
  let peak = 0
  for (let index = 0; index < pcm.length; index += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(index)))
  return peak
}

test('la boucle synthétisée tient un nombre entier de trames', () => {
  const pcm = synthesizedPcm(8000)
  assert.equal(pcm.length % FRAME_BYTES, 0)
  assert.ok(pcm.length > 8000 * 2 * 2, 'au moins deux secondes')
})

test('la boucle reste audible sans saturer', () => {
  const pcm = holdMusicPcm({ sampleRate: 8000, volume: 0.18 })
  const peak = peakOf(pcm)
  assert.ok(peak > 2000, `pic trop faible: ${peak}`)
  assert.ok(peak < 12000, `pic trop fort: ${peak}`)
})

test('un volume plus élevé produit un pic plus élevé', () => {
  assert.ok(peakOf(synthesizedPcm(8000, 0.4)) > peakOf(synthesizedPcm(8000, 0.1)))
})

test('un fichier inconnu retombe sur la boucle synthétisée', () => {
  const pcm = holdMusicPcm({ sampleRate: 8000, file: '/chemin/qui/n/existe/pas.wav' })
  assert.ok(peakOf(pcm) > 0)
})

test('readWavPcm16 refuse un fichier qui n’est pas un WAV', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hold-'))
  const path = join(directory, 'pas-un-wav.bin')
  writeFileSync(path, Buffer.alloc(64, 7))
  assert.equal(readWavPcm16(path, 8000), null)
})

test('readWavPcm16 rend les échantillons d’un WAV mono 16 bits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hold-'))
  const path = join(directory, 'attente.wav')
  const samples = Buffer.alloc(16)
  samples.writeInt16LE(1000, 0)
  samples.writeInt16LE(-1000, 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(samples.length, 40)
  writeFileSync(path, Buffer.concat([header, samples]))
  const pcm = readWavPcm16(path, 8000)
  assert.equal(pcm.length, samples.length)
  assert.equal(pcm.readInt16LE(0), 1000)
})
