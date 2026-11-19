/**
 * Le pont vocal : écoute AudioSocket sur les ports configurés, ouvre un
 * `CallSession` par appel, compose les appels sortants par AMI et expose
 * l'état que lisent les outils du harnais.
 *
 * Aucun service DSH n'est requis ici : `services` (ASR, TTS, agent) et
 * `resolveSecret` sont injectés, ce qui rend le pont testable sans instance.
 */

import dgram from 'node:dgram'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { CallSession } from './calls.js'
import { originateCall } from './ami.js'
import { outboundChannel } from './config.js'

/** Durée pendant laquelle un appel sortant attendu est reconnu comme tel. */
const OUTBOUND_WINDOW_MS = 60000

export class VoiceBridge {
  #servers = []
  #calls = new Set()
  #lastCall = null
  #outbound = { queued: 0, at: 0, opening: '' }
  #startedAt = null

  /**
   * @param {object} options
   * @param {object} options.config configuration effective
   * @param {object} options.logger journal
   * @param {{asr: object, tts: object, agents: object}} options.services
   * @param {() => Promise<{value: string, source: string}|undefined>} options.resolveSecret
   * @param {{originateCall: Function}} [options.ami] client AMI (remplaçable en test)
   */
  constructor({ config, logger, services, resolveSecret, ami = { originateCall } }) {
    this.config = config
    this.logger = logger
    this.services = services
    this.resolveSecret = resolveSecret
    this.ami = ami
  }

  /** Ouvre un serveur par port configuré. Un port occupé n'empêche pas les autres. */
  async start() {
    this.#startedAt = Date.now()
    for (const port of this.config.ports) {
      const server = net.createServer((socket) => this.#accept(socket))
      const listening = await new Promise((resolve) => {
        server.once('error', (error) => {
          this.logger.warn(`wazo-voice: port ${port} indisponible — ${error.message}`)
          resolve(false)
        })
        server.listen(port, this.config.bind, () => resolve(true))
      })
      if (!listening) {
        server.close()
        continue
      }
      const address = server.address()
      this.#servers.push({ server, port: address.port, address: address.address })
      this.logger.info(`wazo-voice: AudioSocket à l'écoute sur ${address.address}:${address.port}`)
    }
    return this.#servers.map(({ port, address }) => ({ port, address }))
  }

  /** Ferme les serveurs et raccroche les appels en cours. */
  async stop() {
    // Les appels d'abord : un socket client encore ouvert empêcherait
    // `server.close()` de se résoudre et le déchargement du plugin avec lui.
    for (const call of [...this.#calls]) call.close('plugin déchargé')
    this.#calls.clear()
    for (const { server } of this.#servers) await new Promise((resolve) => server.close(resolve))
    this.#servers = []
  }

  /** Ports et adresses réellement écoutés. */
  get listening() {
    return this.#servers.map(({ port, address }) => ({ port, address }))
  }

  /** Appels en cours. */
  get calls() {
    return [...this.#calls]
  }

  /** Dernier appel terminé (statut conservé pour diagnostic). */
  get lastCall() {
    return this.#lastCall?.status() ?? null
  }

  /**
   * Compose un appel sortant. La réponse AMI prouve la mise en file d'attente,
   * pas le décrochage : la preuve de décrochage est la connexion AudioSocket.
   */
  async call({ to, opening } = {}) {
    if (this.#calls.size > 0) throw new Error('un appel est déjà en cours')
    const secret = await this.resolveSecret()
    if (secret === undefined || secret.value === '') {
      const ref = this.config.ami.secretRef
      throw new Error(`secret AMI absent : enregistre-le avec wazo_voice_configure, ou définis ${ref} dans l'environnement du harnais`)
    }
    const channel = outboundChannel(this.config.ami, to)
    const port = this.listening[0]?.port
    if (port === undefined) throw new Error('aucun port AudioSocket n’est à l’écoute')
    const application = this.config.ami.application ?? 'AudioSocket'
    const host = application === '' ? undefined : await this.#advertiseHost()
    if (application !== '' && host === undefined) {
      throw new Error('adresse locale introuvable : renseigne ami.advertiseHost dans la config')
    }
    const data = application === '' ? undefined : `${randomUUID()},${host}:${port}`
    const { fields } = await this.ami.originateCall(this.config.ami, secret.value, {
      channel,
      application,
      data,
      context: this.config.ami.context,
      exten: this.config.ami.exten,
    })
    this.#outbound = {
      queued: 1,
      at: Date.now(),
      opening: typeof opening === 'string' ? opening : this.config.greet.outbound,
    }
    return {
      channel,
      application: application === '' ? null : application,
      data: data ?? null,
      queued: true,
      actionId: fields.ActionID ?? null,
      response: fields.Response ?? null,
      note: 'Le décrochage se constate quand l’AudioSocket se connecte ; wazo_voice_status le montre.',
    }
  }

  /** Adresse IPv4 par laquelle le PBX peut nous joindre. */
  async #advertiseHost() {
    const configured = this.config.ami.advertiseHost
    if (typeof configured === 'string' && configured !== '') return configured
    return await localAddressFor(this.config.ami.host, this.config.ami.port)
  }

  /**
   * Demande le raccrochage de tous les appels. La phrase en cours est dite
   * d'abord : l'agent appelle raccrocher dans le même message que ses adieux.
   * @returns {number} nombre d'appels concernés
   */
  hangup() {
    let requested = 0
    for (const call of [...this.#calls]) {
      if (call.requestHangup()) requested += 1
    }
    return requested
  }

  /** Dit une phrase sur l'appel en cours. */
  async say(text) {
    const call = [...this.#calls][0]
    if (call === undefined) throw new Error('aucun appel en cours')
    if (typeof text !== 'string' || text.trim() === '') throw new Error('texte requis')
    return await call.speak(text)
  }

  /**
   * Prononce sur l'appel en cours une réponse écrite dans la conversation.
   * Sans appel, il n'y a rien à dire : ce n'est pas une erreur.
   * @param {string} text réponse écrite
   * @returns {Promise<boolean>} vrai si une phrase a été mise en file
   */
  async announce(text) {
    const call = [...this.#calls][0]
    if (call === undefined) return false
    return call.announce(text)
  }

  /**
   * Joue un PCM sur l'appel en cours (extrait musical, ambiance).
   * @param {Buffer} pcm échantillons int16 à la fréquence du canal
   */
  async play(pcm) {
    const call = [...this.#calls][0]
    if (call === undefined) throw new Error('aucun appel en cours')
    await call.play(pcm)
    return true
  }

  /** Photographie complète pour `wazo_voice_status`. */
  status() {
    return {
      startedAt: this.#startedAt === null ? null : new Date(this.#startedAt).toISOString(),
      listening: this.listening,
      active: [...this.#calls].map((call) => call.status()),
      last: this.lastCall,
      outboundPending: this.#outbound.queued > 0 && Date.now() - this.#outbound.at < OUTBOUND_WINDOW_MS,
    }
  }

  #accept(socket) {
    const remote = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`
    const outbound = this.#outbound.queued > 0 && Date.now() - this.#outbound.at < OUTBOUND_WINDOW_MS
    let opening = this.config.greet.inbound
    if (outbound) {
      opening = this.#outbound.opening || this.config.greet.outbound
      this.#outbound = { queued: 0, at: 0, opening: '' }
    }
    const call = new CallSession({
      socket,
      remote,
      direction: outbound ? 'outbound' : 'inbound',
      config: this.config,
      services: this.services,
      logger: this.logger,
      opening,
      onEnd: (ended) => {
        this.#calls.delete(ended)
        this.#lastCall = ended
      },
    })
    this.#calls.add(call)
    call.start()
  }
}

/**
 * Adresse IPv4 locale que la route vers `host` utiliserait.
 * Une socket UDP « connectée » ne émet rien : elle fixe seulement la route.
 */
async function localAddressFor(host, port) {
  return await new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket.close() } catch { /* déjà fermée */ }
      resolve(value)
    }
    socket.once('error', () => finish(undefined))
    const timer = setTimeout(() => finish(undefined), 1000)
    timer.unref?.()
    socket.connect(port, host, () => {
      clearTimeout(timer)
      const address = socket.address()?.address
      finish(typeof address === 'string' && address !== '' && address !== '0.0.0.0' ? address : undefined)
    })
  })
}
