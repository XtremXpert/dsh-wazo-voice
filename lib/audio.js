/**
 * AudioSocket et traitement PCM.
 *
 * Protocole Asterisk AudioSocket : chaque trame est
 * `[type: 1 octet][longueur: 2 octets big-endian][charge utile]`.
 *   0x00 raccrochage, 0x01 UUID du canal (16 octets), 0x03 DTMF, 0x10 audio.
 *
 * Le canal `slin` est du PCM signé 16 bits little-endian, mono, 8 kHz : une
 * trame de 20 ms pèse 320 octets. Écrire plus vite que le temps réel remplit
 * le tampon d'Asterisk, qui jette l'audio en silence : le cadencement est une
 * contrainte du protocole, pas un détail.
 */

/** Types de trame AudioSocket. */
export const KIND = Object.freeze({ HANGUP: 0x00, UUID: 0x01, DTMF: 0x03, AUDIO: 0x10 })

/** Octets d'une trame audio de 20 ms à 8 kHz mono 16 bits. */
export const FRAME_BYTES = 320

/** Durée d'une trame, en millisecondes. */
export const FRAME_MS = 20

/** Encode une trame AudioSocket. */
export function encodeFrame(kind, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (body.length > 0xffff) throw new Error(`trame trop longue: ${body.length}`)
  const header = Buffer.alloc(3)
  header[0] = kind
  header.writeUInt16BE(body.length, 1)
  return Buffer.concat([header, body])
}

/**
 * Décode un flux AudioSocket fragmenté arbitrairement.
 * Les trames incomplètes restent dans le tampon jusqu'au prochain `push`.
 */
export class FrameParser {
  #buffer = Buffer.alloc(0)

  /** Ajoute des octets et retourne toutes les trames complètes disponibles. */
  push(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const frames = []
    while (this.#buffer.length >= 3) {
      const kind = this.#buffer[0]
      const length = this.#buffer.readUInt16BE(1)
      if (this.#buffer.length < 3 + length) break
      frames.push({ kind, payload: Buffer.from(this.#buffer.subarray(3, 3 + length)) })
      this.#buffer = this.#buffer.subarray(3 + length)
    }
    return frames
  }

  /** Octets d'une trame partielle en attente. */
  get pending() {
    return this.#buffer.length
  }
}

/** Énergie RMS (échelle int16) d'un tampon PCM mono 16 bits. */
export function rms16(buffer) {
  const samples = buffer.length >> 1
  if (samples === 0) return 0
  let sum = 0
  for (let index = 0; index < samples; index += 1) {
    const sample = buffer.readInt16LE(index * 2)
    sum += sample * sample
  }
  return Math.sqrt(sum / samples)
}

/**
 * Découpe la parole d'un flux continu en énoncés.
 *
 * Un pré-roll conserve les derniers 300 ms de silence pour ne pas amputer
 * l'attaque du premier mot. Un énoncé se ferme après `endSilenceMs` de
 * silence, ou de force au-delà de `maxUtteranceMs`.
 */
export class SpeechDetector {
  #speech = false
  #silenceBytes = 0
  #utteranceBytes = 0
  #chunks = []
  #preRoll = []
  #preRollBytes = 0

  constructor(options = {}, sampleRate = 8000) {
    this.threshold = options.threshold ?? 450
    this.endSilenceBytes = msToBytes(options.endSilenceMs ?? 600, sampleRate)
    this.minSpeechBytes = msToBytes(options.minSpeechMs ?? 300, sampleRate)
    this.maxUtteranceBytes = msToBytes(options.maxUtteranceMs ?? 30000, sampleRate)
    this.preRollBytes = msToBytes(options.preRollMs ?? 300, sampleRate)
  }

  /** Ajoute un tampon PCM et retourne les énoncés terminés par cet ajout. */
  push(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) return []
    const finished = []
    const voiced = rms16(pcm) >= this.threshold

    if (!this.#speech) {
      if (!voiced) {
        this.#rememberPreRoll(pcm)
        return finished
      }
      this.#speech = true
      this.#silenceBytes = 0
      this.#chunks = [...this.#preRoll, pcm]
      this.#utteranceBytes = this.#preRollBytes + pcm.length
      this.#preRoll = []
      this.#preRollBytes = 0
    } else {
      this.#chunks.push(pcm)
      this.#utteranceBytes += pcm.length
      this.#silenceBytes = voiced ? 0 : this.#silenceBytes + pcm.length
    }

    if (this.#silenceBytes >= this.endSilenceBytes || this.#utteranceBytes >= this.maxUtteranceBytes) {
      const utterance = Buffer.concat(this.#chunks)
      if (utterance.length >= this.minSpeechBytes) finished.push(utterance)
      this.#reset()
    }
    return finished
  }

  /** Énoncé en cours, sans le fermer (diagnostic). */
  get speaking() {
    return this.#speech
  }

  /** Oublie l'énoncé en cours (bascule en synthèse, fin d'appel). */
  reset() {
    this.#reset()
    this.#preRoll = []
    this.#preRollBytes = 0
  }

  #rememberPreRoll(pcm) {
    this.#preRoll.push(pcm)
    this.#preRollBytes += pcm.length
    while (this.#preRollBytes > this.preRollBytes && this.#preRoll.length > 1) {
      this.#preRollBytes -= this.#preRoll.shift().length
    }
  }

  #reset() {
    this.#speech = false
    this.#silenceBytes = 0
    this.#utteranceBytes = 0
    this.#chunks = []
  }
}

/** Silence PCM de `ms` millisecondes. */
export function silencePcm(ms, sampleRate = 8000) {
  return Buffer.alloc(msToBytes(ms, sampleRate))
}

/** Millisecondes → octets de PCM mono 16 bits. */
export function msToBytes(ms, sampleRate = 8000) {
  return Math.max(0, Math.round((ms * sampleRate * 2) / 1000))
}

/**
 * Décode un conteneur WAV (RIFF) en ses composantes utiles.
 * Accepte les chunks dans n'importe quel ordre ; refuse ce qu'il ne sait pas lire.
 */
export function decodeWav(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV invalide (en-tête RIFF/WAVE absent)')
  }
  let offset = 12
  let format
  let data
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length))
    }
    offset = body + size + (size % 2)
  }
  if (!format || !data) throw new Error('WAV invalide (chunk fmt ou data absent)')
  return { ...format, data }
}

/** Réduit un PCM multicanal 16 bits en mono 16 bits. */
export function toMono16(data, channels, bitsPerSample) {
  if (bitsPerSample !== 16) throw new Error(`profondeur non gérée: ${bitsPerSample} bits`)
  if (channels === 1) return data
  if (channels < 1) throw new Error(`nombre de canaux invalide: ${channels}`)
  const frames = Math.floor(data.length / (2 * channels))
  const mono = Buffer.alloc(frames * 2)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += data.readInt16LE((frame * channels + channel) * 2)
    }
    mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), frame * 2)
  }
  return mono
}

/**
 * Rééchantillonne un PCM mono 16 bits.
 * En réduction, chaque échantillon de sortie moyenne la fenêtre source
 * (filtre passe-bas sommaire) ; en augmentation, interpolation linéaire.
 */
export function resampleMono16(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm
  if (fromRate <= 0 || toRate <= 0) throw new Error(`fréquences invalides: ${fromRate} → ${toRate}`)
  const input = pcm.length >> 1
  if (input === 0) return Buffer.alloc(0)
  const output = Math.max(1, Math.round((input * toRate) / fromRate))
  const result = Buffer.alloc(output * 2)
  const ratio = fromRate / toRate
  for (let index = 0; index < output; index += 1) {
    const start = index * ratio
    let value
    if (ratio > 1) {
      const first = Math.floor(start)
      const last = Math.min(input, Math.ceil(start + ratio))
      let sum = 0
      let count = 0
      for (let source = first; source < last; source += 1) {
        sum += pcm.readInt16LE(source * 2)
        count += 1
      }
      value = count > 0 ? sum / count : 0
    } else {
      const first = Math.min(input - 1, Math.floor(start))
      const second = Math.min(input - 1, first + 1)
      const fraction = start - first
      value = pcm.readInt16LE(first * 2) * (1 - fraction) + pcm.readInt16LE(second * 2) * fraction
    }
    result.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), index * 2)
  }
  return result
}
