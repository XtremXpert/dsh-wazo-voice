/**
 * Client du service de reconnaissance vocale local.
 *
 * Contrat (dsh-asr-service.py, MLX Whisper) : `POST <url>/?language=fr` avec un
 * corps PCM int16-LE mono 8 kHz sans en-tête WAV, réponse `{ text, seconds }`.
 */

/**
 * Transcrit un énoncé PCM 8 kHz.
 * @param {Buffer} pcm énoncé complet, sans en-tête.
 * @param {{url: string, language?: string, timeoutMs?: number}} config
 * @returns {Promise<{text: string, seconds: number, bytes: number}>}
 */
export async function transcribe(pcm, config) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) return { text: '', seconds: 0, bytes: 0 }
  const url = new URL(config.url)
  if (config.language) url.searchParams.set('language', config.language)
  const timeoutMs = config.timeoutMs ?? 60000
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: pcm,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`ASR injoignable (${url.origin}): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`ASR ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }
  const payload = await response.json().catch(() => ({}))
  return {
    text: typeof payload.text === 'string' ? payload.text.trim() : '',
    seconds: Number(payload.seconds) || 0,
    bytes: pcm.length,
  }
}

/** Sonde de disponibilité du service (statut HTTP sans consommer d'audio). */
export async function probe(config, timeoutMs = 1500) {
  const url = new URL(config.url)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const payload = await response.json().catch(() => null)
    return {
      ok: response.ok,
      status: response.status,
      model: payload?.model ?? null,
      defaultLanguage: payload?.defaultLanguage ?? null,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
