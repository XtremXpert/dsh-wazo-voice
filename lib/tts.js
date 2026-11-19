/**
 * Synthèse vocale locale.
 *
 * Deux moteurs, dans cet ordre :
 *   - `kokoro` : `POST <url>` `{ text, voice, speed }` → `audio/wav` 24 kHz
 *     mono (dsh-tts-service.py, Kokoro v1.0 sur CPU) ;
 *   - `say` : `say -v Amelie` puis `afconvert` en 8 kHz mono, sans modèle ni
 *     dépendance (macOS uniquement), utilisé en repli.
 *
 * Dans les deux cas la sortie est ramenée au PCM 8 kHz que le canal
 * AudioSocket attend.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decodeWav, resampleMono16, toMono16 } from './audio.js'

const run = promisify(execFile)

/**
 * Synthétise un texte en PCM 8 kHz prêt pour AudioSocket.
 * @param {string} text texte à dire (déjà nettoyé pour l'oral).
 * @param {object} config section `tts` de la configuration.
 * @returns {Promise<{pcm: Buffer, source: 'kokoro'|'say', sampleRate: number, fallbackOf?: string}>}
 */
export async function synthesize(text, config) {
  const spoken = normalize(text)
  if (spoken === '') throw new Error('texte vide')
  if (config.provider === 'say') return await synthesizeWithSay(spoken, config)
  try {
    return await synthesizeWithKokoro(spoken, config)
  } catch (error) {
    if (config.fallbackToSay === false) throw error
    const fallback = await synthesizeWithSay(spoken, config)
    return { ...fallback, fallbackOf: error instanceof Error ? error.message : String(error) }
  }
}

/** Retire ce qu'on ne sait pas dire : balisage et espaces multiples. */
export function normalize(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function synthesizeWithKokoro(text, config) {
  const timeoutMs = config.timeoutMs ?? 90000
  let response
  try {
    response = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice: config.voice, speed: config.speed ?? 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`TTS injoignable (${config.url}): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`TTS ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }
  const wav = decodeWav(Buffer.from(await response.arrayBuffer()))
  const mono = toMono16(wav.data, wav.channels, wav.bitsPerSample)
  return { pcm: resampleMono16(mono, wav.sampleRate, config.sampleRate), source: 'kokoro', sampleRate: config.sampleRate }
}

async function synthesizeWithSay(text, config) {
  const folder = await mkdtemp(join(tmpdir(), 'wazo-voice-'))
  const aiff = join(folder, 'voice.aiff')
  const wavPath = join(folder, 'voice.wav')
  const timeout = config.timeoutMs ?? 90000
  try {
    await run('say', ['-v', config.sayVoice ?? 'Amelie', '-o', aiff, text], { timeout })
    await run('afconvert', ['-f', 'WAVE', '-d', `LEI16@${config.sampleRate ?? 8000}`, '-c', '1', aiff, wavPath], { timeout })
    const wav = decodeWav(await readFile(wavPath))
    const mono = toMono16(wav.data, wav.channels, wav.bitsPerSample)
    return { pcm: resampleMono16(mono, wav.sampleRate, config.sampleRate ?? 8000), source: 'say', sampleRate: config.sampleRate ?? 8000 }
  } catch (error) {
    throw new Error(`synthèse macOS impossible (say/afconvert): ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => {})
  }
}

/** Sonde le service Kokoro (lecture de sa racine). */
export async function probe(config, timeoutMs = 5000) {
  if (config.provider === 'say') return { ok: true, provider: 'say' }
  const url = new URL(config.url)
  url.pathname = '/'
  url.search = ''
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const payload = await response.json().catch(() => null)
    return { ok: response.ok, provider: 'kokoro', status: response.status, voice: payload?.voice ?? null }
  } catch (error) {
    // Une synthèse en cours occupe le service mono-thread : ce n'est pas une panne.
    const busy = error?.name === 'TimeoutError' || /aborted/i.test(String(error?.message ?? ''))
    return { ok: false, provider: 'kokoro', busy, error: busy ? 'occupé (synthèse en cours)' : String(error?.message ?? error) }
  }
}
