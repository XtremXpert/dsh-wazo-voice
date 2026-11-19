/**
 * Client AMI (Asterisk Manager Interface) minimal : connexion, `Originate`,
 * `Hangup`. AMI est le seul chemin sortant disponible sans greffon côté Wazo :
 * Asterisk compose le canal, le plan de numérotation répond, puis ouvre
 * l'AudioSocket vers ce plugin.
 *
 * Le secret n'est jamais stocké ici : il est résolu par l'appelant
 * (`credentials.resolve`) et passé à `connect`.
 */

import net from 'node:net'

/** Décode un bloc AMI `Clé: valeur` en objet. */
export function parseAmiBlock(block) {
  const fields = {}
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (key === '') continue
    fields[key] = line.slice(separator + 1).trim()
  }
  return fields
}

/** Erreur portant la réponse AMI complète (diagnostic). */
export class AmiError extends Error {
  constructor(message, fields = {}) {
    super(message)
    this.name = 'AmiError'
    this.fields = fields
  }
}

/** Une connexion AMI, ouverte pour une action puis refermée. */
export class AmiClient {
  #socket
  #buffer = ''
  #waiter
  #closed = false

  constructor(socket) {
    this.#socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('close', () => this.#fail(new AmiError('connexion AMI fermée')))
    socket.on('error', (error) => this.#fail(new AmiError(`AMI: ${error.message}`)))
  }

  /** Ouvre la connexion et s'authentifie. */
  static async connect({ host, port = 5038, user, secret, timeoutMs = 10000 }) {
    if (typeof secret !== 'string' || secret === '') throw new AmiError('secret AMI absent')
    const socket = net.createConnection({ host, port })
    socket.setNoDelay(true)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AmiError(`connexion AMI ${host}:${port} expirée`)), timeoutMs)
      socket.once('connect', () => { clearTimeout(timer); resolve() })
      socket.once('error', (error) => { clearTimeout(timer); reject(new AmiError(`AMI ${host}:${port}: ${error.message}`)) })
    })
    const client = new AmiClient(socket)
    const response = await client.action({ Action: 'Login', Username: user, Secret: secret }, timeoutMs)
    if (response.Response !== 'Success') {
      client.close()
      throw new AmiError(`authentification AMI refusée: ${response.Message ?? response.Response}`, response)
    }
    return client
  }

  /** Envoie une action et attend son bloc de réponse. */
  async action(fields, timeoutMs = 10000) {
    if (this.#closed) throw new AmiError('connexion AMI fermée')
    if (this.#waiter) throw new AmiError('une action AMI est déjà en cours')
    const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`)
    const block = `${lines.join('\r\n')}\r\n\r\n`
    const waited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = undefined
        reject(new AmiError(`réponse AMI absente (${timeoutMs} ms)`))
      }, timeoutMs)
      this.#waiter = {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      }
    })
    this.#socket.write(block)
    return await waited
  }

  /**
   * Compose un appel.
   * Deux formes : `Application` + `Data` (l'application tourne sur le canal
   * composé, un seul canal, aucun contexte à connaître) ou `Context`/`Exten`
   * (Asterisk crée un second canal et le pont). La réponse prouve seulement
   * la mise en file d'attente.
   */
  async originate({ channel, application, data, context, exten, priority = 1, callerId, timeoutMs = 30000 }) {
    const fields = {
      Action: 'Originate',
      Channel: channel,
      CallerID: callerId ?? '',
      Timeout: timeoutMs,
      Async: 'true',
      ActionID: `wazo-voice-${Date.now()}`,
    }
    if (application) {
      fields.Application = application
      fields.Data = data ?? ''
    } else {
      fields.Context = context
      fields.Exten = exten
      fields.Priority = priority
    }
    const response = await this.action(fields, timeoutMs + 5000)
    if (response.Response !== 'Success') {
      throw new AmiError(`Originate refusé: ${response.Message ?? response.Response}`, response)
    }
    return response
  }

  /** Raccroche un canal composé. */
  async hangup(channel) {
    try {
      return await this.action({ Action: 'Hangup', Channel: channel }, 5000)
    } catch {
      return undefined
    }
  }

  close() {
    this.#closed = true
    this.#socket.destroy()
  }

  #onData(chunk) {
    this.#buffer += chunk
    while (true) {
      const boundary = findBoundary(this.#buffer)
      if (boundary === undefined) return
      const block = this.#buffer.slice(0, boundary.index)
      this.#buffer = this.#buffer.slice(boundary.index + boundary.length)
      if (block.trim() === '') continue
      const fields = parseAmiBlock(block)
      if (this.#waiter) {
        const waiter = this.#waiter
        this.#waiter = undefined
        waiter.resolve(fields)
      }
    }
  }

  #fail(error) {
    if (this.#closed && this.#waiter === undefined) return
    this.#closed = true
    if (this.#waiter) {
      const waiter = this.#waiter
      this.#waiter = undefined
      waiter.reject(error)
    }
  }
}

/** Position de la première frontière de bloc (`\r\n\r\n` ou `\n\n`). */
function findBoundary(text) {
  const crlf = text.indexOf('\r\n\r\n')
  const lf = text.indexOf('\n\n')
  if (crlf < 0 && lf < 0) return undefined
  if (crlf < 0) return { index: lf, length: 2 }
  if (lf < 0 || crlf <= lf) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

/**
 * Compose un appel sortant sur une connexion éphémère.
 * @returns {Promise<{fields: object, channel: string}>}
 */
export async function originateCall(config, secret, { channel, application, data, context, exten } = {}) {
  const client = await AmiClient.connect({
    host: config.host,
    port: config.port,
    user: config.user,
    secret,
    timeoutMs: config.timeoutMs,
  })
  try {
    const fields = await client.originate({
      channel,
      application,
      data,
      context,
      exten,
      callerId: config.callerId,
      timeoutMs: config.timeoutMs,
    })
    return { fields, channel }
  } finally {
    client.close()
  }
}
