/**
 * Un appel AudioSocket : trame les octets du canal, détecte les énoncés,
 * conduit le tour (ASR → agent → synthèse) et recadence l'audio sortant.
 *
 * L'agent est réveillé par `followup()` : il ne s'agit pas d'une façade
 * statique mais de la même conversation que celle du harnais, avec ses outils
 * et sa mémoire.
 */

import { FRAME_BYTES, FRAME_MS, FrameParser, KIND, SpeechDetector, encodeFrame } from './audio.js'
import { holdMusicPcm } from './hold-music.js'

const KEEP_TRANSCRIPT = 40

/** Au-delà, le tampon d'écriture n'est plus un retard mais une panne. */
const MAX_WRITE_BUFFER_BYTES = 1 << 20

/** Un appel en cours. */
export class CallSession {
  #socket
  #parser = new FrameParser()
  #detector
  #state = 'listening'
  #closed = false
  #endedAt = null
  #endedReason = null
  #uuid = null
  #items = []
  #pumping = false
  #transcript = []
  #stats = { frames: 0, bytesIn: 0, bytesOut: 0, utterances: 0, turns: 0, dropped: 0 }
  #lastUserText = ''
  #lastReply = ''
  #lastError = null
  #startedAt = Date.now()
  #hangupRequested = false
  #holdPcm = null
  #holdPlaying = false
  #holdPromise = undefined

  /**
   * @param {object} options
   * @param {import('node:net').Socket} options.socket canal ouvert par Asterisk
   * @param {string} options.remote adresse distante
   * @param {'inbound'|'outbound'} options.direction
   * @param {object} options.config configuration effective
   * @param {object} options.services `{ asr, tts, agents }`
   * @param {object} options.logger journal du plugin
   * @param {string} options.opening phrase d'accueil ('' pour aucune)
   * @param {(session: CallSession) => void} options.onEnd rappel de fermeture
   */
  constructor({ socket, remote, direction, config, services, logger, opening, onEnd }) {
    this.#socket = socket
    this.remote = remote
    this.direction = direction
    this.config = config
    this.services = services
    this.logger = logger
    this.opening = opening ?? ''
    this.onEnd = onEnd
    this.#detector = new SpeechDetector(config.vad, config.sampleRate)
    this.#holdPcm = config.holdMusic?.enabled === false
      ? null
      : holdMusicPcm({ sampleRate: config.sampleRate, file: config.holdMusic?.file, volume: config.holdMusic?.volume })
    socket.setNoDelay(true)
  }

  /** Démarre l'écoute du canal. */
  start() {
    this.#socket.on('data', (chunk) => this.#onData(chunk))
    this.#socket.on('close', () => this.#end('canal fermé'))
    this.#socket.on('error', (error) => this.#end(`erreur du canal: ${error.message}`))
    this.logger.info(`wazo-voice: appel ${this.direction} de ${this.remote}`)
    this.#ensureMaxDuration()
    if (this.opening !== '') this.#enqueueGreeting()
    return this
  }

  /** Photographie de l'appel pour `wazo_voice_status`. */
  status() {
    return {
      direction: this.direction,
      state: this.#closed ? 'ended' : this.#state,
      remote: this.remote,
      uuid: this.#uuid,
      startedAt: new Date(this.#startedAt).toISOString(),
      durationMs: (this.#endedAt ?? Date.now()) - this.#startedAt,
      stats: { ...this.#stats },
      pending: this.#items.length,
      lastUserText: this.#lastUserText,
      lastReply: this.#lastReply,
      lastError: this.#lastError,
      agent: this.services.agents?.info?.() ?? null,
      transcript: this.#transcript.slice(-8),
      endedReason: this.#endedReason,
    }
  }

  /** Termine l'appel (raccrochage, erreur, arrêt du plugin). */
  close(reason = 'arrêt demandé') {
    this.#end(reason)
  }

  /**
   * Demande le raccrochage sans couper la phrase en cours.
   *
   * L'agent appelle `wazo_voice_hangup` dans le même message que ses adieux :
   * raccrocher tout de suite ferait perdre cette phrase. Le raccrochage est
   * donc différé à la fin du tour (ou immédiat si l'appel est au repos).
   * @returns {boolean} vrai si un raccrochage a été demandé ou était déjà fait
   */
  requestHangup() {
    if (this.#closed) return false
    this.#hangupRequested = true
    this.#settleHangup()
    return true
  }

  /**
   * Joue un PCM déjà préparé sur la ligne, hors synthèse (extrait musical).
   * @param {Buffer} pcm échantillons int16 little-endian à la fréquence du canal
   */
  async play(pcm) {
    if (this.#closed) throw new Error('appel terminé')
    await this.#stopHold()
    await this.#speakPcm(pcm)
  }

  /** Dit une phrase maintenant (accueil, outil `wazo_voice_say`). */
  async speak(text) {
    if (this.#closed) throw new Error('appel terminé')
    const audio = await this.services.tts.synthesize(text)
    await this.#speakPcm(audio.pcm)
    return audio
  }

  /**
   * Fait dire une réponse écrite, dans la file des tours : elle attend la fin
   * de la phrase en cours au lieu de la chevaucher (pas de barge-in).
   * @param {string} text réponse tapée dans la conversation
   * @returns {boolean} vrai si la phrase a été mise en file
   */
  announce(text) {
    const spoken = plainSpeech(text)
    if (this.#closed || spoken === '') return false
    this.#items.push({ kind: 'announce', text: spoken })
    this.#pump()
    return true
  }

  #onData(chunk) {
    this.#stats.bytesIn += chunk.length
    for (const frame of this.#parser.push(chunk)) {
      if (frame.kind === KIND.HANGUP) {
        this.#end('raccroché par le correspondant')
        return
      }
      if (frame.kind === KIND.UUID) {
        this.#uuid = frame.payload.toString('hex')
        continue
      }
      if (frame.kind !== KIND.AUDIO) continue
      this.#stats.frames += 1
      this.#onAudio(frame.payload)
    }
  }

  #onAudio(pcm) {
    // Pas de barge-in : la voix de l'agent ne doit pas s'entendre avec celle
    // du correspondant, et l'ASR ne doit pas transcrire la synthèse.
    if (this.#state === 'speaking') {
      this.#stats.dropped += 1
      return
    }
    for (const utterance of this.#detector.push(pcm)) this.#enqueueUtterance(utterance)
  }

  #enqueueUtterance(utterance) {
    const waiting = this.#items.filter((item) => item.kind === 'utterance')
    if (waiting.length >= this.config.maxQueuedTurns) {
      // Le plus récent remplace le plus ancien en attente : au téléphone, la
      // dernière question est celle qui compte, pas la file d'attente.
      const oldest = this.#items.findIndex((item) => item.kind === 'utterance')
      if (oldest >= 0) this.#items.splice(oldest, 1)
      this.#stats.dropped += 1
      this.logger.warn('wazo-voice: énoncé en attente remplacé par le plus récent')
    }
    this.#items.push({ kind: 'utterance', pcm: utterance })
    this.#pump()
  }

  /** Une seule boucle consomme la file : accueil puis tours, dans l'ordre. */
  async #pump() {
    if (this.#pumping) return
    this.#pumping = true
    try {
      while (this.#items.length > 0 && !this.#closed) {
        const item = this.#items.shift()
        try {
          if (item.kind === 'greet') await this.#greet()
          else if (item.kind === 'announce') await this.#announce(item.text)
          else await this.#turn(item.pcm)
        } catch (error) {
          this.#lastError = error instanceof Error ? error.message : String(error)
          this.logger.warn(`wazo-voice: tour en échec — ${this.#lastError}`)
        }
      }
    } finally {
      this.#pumping = false
      if (!this.#closed && this.#state === 'thinking') this.#setState('listening')
      this.#settleHangup()
    }
  }

  async #turn(utterance) {
    if (this.#closed) return
    this.#setState('thinking')
    this.#startHold()
    try {
      const durationMs = Math.round((utterance.length / 2 / this.config.sampleRate) * 1000)
      const { text } = await this.services.asr.transcribe(utterance)
      if (this.#closed) return
      if (text === '') {
        this.logger.info(`wazo-voice: énoncé de ${durationMs} ms sans texte`)
        return
      }
      this.#lastUserText = text
      this.#remember('user', text)
      this.#stats.utterances += 1
      this.logger.info(`wazo-voice: « ${text.slice(0, 160)} »`)

      const reply = await this.services.agents.ask(text)
      if (this.#closed) return
      if (reply === '') {
        this.#lastError = this.services.agents.info?.()?.lastError ?? 'réponse vide de l’agent'
        return
      }
      this.#lastReply = reply
      this.#remember('assistant', reply)
      this.logger.info(`wazo-voice: réponse « ${reply.slice(0, 160)} »`)

      await this.#stopHold()
      const audio = await this.services.tts.synthesize(reply)
      if (this.#closed) return
      this.#stats.turns += 1
      await this.#speakPcm(audio.pcm)
    } finally {
      await this.#stopHold()
      if (!this.#closed && this.#state === 'thinking') this.#setState('listening')
      this.#settleHangup()
    }
  }

  /** Raccroche si demandé et si aucun tour ne parle encore. */
  #settleHangup() {
    if (!this.#hangupRequested || this.#closed) return
    if (this.#pumping || this.#state === 'speaking') return
    this.#end('raccroché par l’agent')
  }

  #enqueueGreeting() {
    this.#items.unshift({ kind: 'greet' })
    this.#pump()
  }

  async #greet() {
    await this.#speakPcm((await this.services.tts.synthesize(this.opening)).pcm)
  }

  /** Musique d'attente pendant la réflexion : elle tourne jusqu'à la réponse. */
  #startHold() {
    if (this.#holdPcm === null || this.#holdPlaying || this.#closed) return
    this.#holdPromise = this.#holdLoop()
  }

  /** Coupe la musique et attend la dernière trame écrite (aucun chevauchement). */
  async #stopHold() {
    if (!this.#holdPlaying && this.#holdPromise === undefined) return
    this.#holdPlaying = false
    const running = this.#holdPromise
    this.#holdPromise = undefined
    try {
      await running
    } catch {
      /* la musique ne doit jamais faire échouer un appel */
    }
  }

  async #holdLoop() {
    const pcm = this.#holdPcm
    const started = Date.now()
    let index = 0
    this.#holdPlaying = true
    try {
      while (this.#holdPlaying && !this.#closed) {
        const offset = (index * FRAME_BYTES) % pcm.length
        let chunk = pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length))
        if (chunk.length < FRAME_BYTES) {
          chunk = Buffer.concat([chunk, pcm.subarray(0, FRAME_BYTES - chunk.length)])
        }
        await this.#write(encodeFrame(KIND.AUDIO, chunk))
        if (this.#closed) return
        this.#stats.bytesOut += chunk.length
        index += 1
        const wait = started + index * FRAME_MS - Date.now()
        if (wait > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, wait)
            timer.unref?.()
          })
        } else {
          await new Promise((resolve) => setImmediate(resolve))
        }
      }
    } finally {
      this.#holdPlaying = false
    }
  }

  async #announce(text) {
    this.#lastReply = text
    this.#remember('assistant', text)
    await this.#speakPcm((await this.services.tts.synthesize(text)).pcm)
  }

  async #speakPcm(pcm) {
    if (this.#closed || pcm.length === 0) return
    this.#detector.reset()
    this.#setState('speaking')
    try {
      await this.#writePaced(pcm)
    } finally {
      if (!this.#closed) this.#setState('listening')
    }
  }

  /** Écrit des trames de 20 ms, à l'heure du protocole. */
  async #writePaced(pcm) {
    const started = Date.now()
    let index = 0
    for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES, index += 1) {
      if (this.#closed) return
      let chunk = pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length))
      if (chunk.length < FRAME_BYTES) chunk = Buffer.concat([chunk, Buffer.alloc(FRAME_BYTES - chunk.length)])
      await this.#write(encodeFrame(KIND.AUDIO, chunk))
      this.#stats.bytesOut += chunk.length
      const wait = started + (index + 1) * FRAME_MS - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }

  #write(buffer) {
    if (this.#closed || this.#socket.destroyed) return Promise.resolve()
    // Le débit est déjà le temps réel (une trame par 20 ms) : attendre `drain`
    // n'apporte rien et peut figer la ligne indéfiniment si le PBX cesse de
    // lire. Un tampon qui grossit anormalement est un vrai défaut : on coupe
    // franchement plutôt que de laisser l'appel muet.
    const flushed = this.#socket.write(buffer)
    const buffered = this.#socket.writableLength
    if (!flushed && buffered > MAX_WRITE_BUFFER_BYTES) {
      this.#lastError = `tampon d’écriture saturé (${buffered} octets)`
      this.logger.warn(`wazo-voice: ${this.#lastError}`)
      this.#end('tampon d’écriture saturé')
    }
    return Promise.resolve()
  }

  #ensureMaxDuration() {
    if (!Number.isFinite(this.config.maxCallMs) || this.config.maxCallMs <= 0) return
    this.maxTimer = setTimeout(() => this.#end('durée maximale atteinte'), this.config.maxCallMs)
    this.maxTimer.unref?.()
  }

  #setState(state) {
    this.#state = state
  }

  #remember(role, text) {
    this.#transcript.push({ role, text, at: new Date().toISOString() })
    if (this.#transcript.length > KEEP_TRANSCRIPT) this.#transcript.shift()
  }

  #end(reason) {
    if (this.#closed) return
    this.#closed = true
    this.#holdPlaying = false
    this.#endedAt = Date.now()
    this.#endedReason = reason
    clearTimeout(this.maxTimer)
    try { this.#socket.destroy() } catch { /* déjà fermé */ }
    this.logger.info(`wazo-voice: appel terminé (${reason})`)
    this.onEnd?.(this)
  }
}

/** Un texte écrit peut porter du markdown : on le rend dicible. */
function plainSpeech(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>#|~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
