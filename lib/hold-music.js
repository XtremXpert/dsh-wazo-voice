/**
 * Musique d'attente : une boucle PCM 16 bits mono, à la fréquence du canal.
 *
 * Deux sources, dans l'ordre : un fichier WAV (PCM 16 bits, mono, déjà à la
 * fréquence du canal) ou, à défaut, une boucle synthétisée — le plugin ne
 * dépend donc d'aucun fichier pour fonctionner.
 */

import { readFileSync } from 'node:fs'

/** Notes de la boucle synthétisée (sol, la, si, ré montant puis descendant). */
const NOTES = [392.0, 440.0, 493.88, 587.33, 493.88, 440.0]

/** Durée d'une note de la boucle synthétisée. */
const NOTE_MS = 750

/**
 * PCM de la musique d'attente, prêt à être tramé.
 * @param {object} options
 * @param {number} [options.sampleRate] fréquence du canal
 * @param {string} [options.file] chemin d'un WAV PCM 16 bits mono
 * @param {number} [options.volume] amplitude relative (0 à 1)
 * @returns {Buffer} échantillons int16 little-endian
 */
export function holdMusicPcm({ sampleRate = 8000, file = '', volume = 0.18 } = {}) {
  if (typeof file === 'string' && file !== '') {
    try {
      const pcm = readWavPcm16(file, sampleRate)
      if (pcm !== null) return pcm
    } catch {
      /* fichier illisible : la boucle synthétisée prend le relais */
    }
  }
  return synthesizedPcm(sampleRate, volume)
}

/** Boucle douce, sans clic à la jointure : chaque note s'éteint à zéro. */
export function synthesizedPcm(sampleRate, volume = 0.18) {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 8000
  const amp = Math.max(0.02, Math.min(0.6, Number(volume) || 0.18)) * 32767
  const noteSamples = Math.round((rate * NOTE_MS) / 1000)
  const total = noteSamples * NOTES.length
  const buffer = Buffer.alloc(total * 2)
  for (let index = 0; index < total; index += 1) {
    const position = index % noteSamples
    const inNote = position / rate
    const frequency = NOTES[Math.floor(index / noteSamples) % NOTES.length]
    const envelope = Math.min(1, inNote / 0.06) * Math.exp(-inNote * 1.1)
    const time = index / rate
    const tone = Math.sin(2 * Math.PI * frequency * time) * 0.75
    const drone = Math.sin(2 * Math.PI * 196 * time) * 0.25
    const value = Math.round((tone + drone) * envelope * amp)
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, value)), index * 2)
  }
  return buffer
}

/** WAV PCM 16 bits mono à la fréquence attendue, ou `null`. */
export function readWavPcm16(file, sampleRate) {
  const buffer = readFileSync(file)
  if (buffer.length < 44) return null
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let format = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        code: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        rate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      if (format === null) return null
      const mono = format.channels === 1 && format.code === 1 && format.bits === 16
      if (!mono || format.rate !== sampleRate) return null
      return buffer.subarray(body, Math.min(body + size, buffer.length))
    }
    offset = body + size + (size % 2)
  }
  return null
}
