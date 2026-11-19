/**
 * Le cerveau au bout du fil : une session DSH dédiée, réveillée à chaque
 * énoncé transcrit. Le texte de l'agent est rendu à l'appelant pour la
 * synthèse ; rien d'un faux client HTTP ici, la conversation est réelle.
 */

import { randomUUID } from 'node:crypto'

/** Consigne d'oralité, posée sur le contexte de l'agent d'appel. */
export const VOICE_PROMPT = [
  'Tu es au téléphone avec un humain. Ta réponse est lue à voix haute par une synthèse vocale.',
  'Écris uniquement des phrases parlées : une ou deux phrases courtes, sans markdown, sans liste, sans emoji, sans URL.',
  'Ce que tu reçois vient d’une transcription automatique : si un mot est douteux, demande une précision au lieu d’inventer.',
  'Si tu utilises un outil, ne raconte pas ce que tu fais : donne le résultat en une phrase.',
  'L’appel en cours est celui-ci : n’appelle pas wazo_voice_status pour le vérifier.',
  'Quand tu annonces que tu raccroches, appelle wazo_voice_hangup dans le même message : ta phrase est prononcée avant la coupure.',
  'Reste en ligne aussi longtemps que l’humain le souhaite : un simple merci ne met pas fin à l’appel, ne raccroche que lorsque l’humain prend congé ou le demande.',
].join(' ')

/** Placement tardif mais avant les sections terminales du harnais. */
const VOICE_SECTION_ORDER = 900

/** Un tour de parole en échec ou trop lent ne doit pas figer l'appel. */
const DEFAULT_REPLY_TIMEOUT_MS = 120000

export class AgentBridge {
  #handle
  #ctx
  #config
  #logger
  #messages = []
  #disposers = []
  #disposeListener
  #sessionId
  #preferredCaller
  #lastTurnReason = null
  #lastError = null
  #turnSettled
  #turnActive = false
  #onUnspokenReply = null

  constructor({ ctx, config, logger }) {
    this.#ctx = ctx
    this.#config = config
    this.#logger = logger
    this.#sessionId = config.agent.sessionId
  }

  /** L'agent qui a demandé l'appel : il prête son preset à la session d'appel. */
  setPreferredCaller(agent) {
    this.#preferredCaller = agent
  }

  /**
   * Réponses écrites (message tapé dans la conversation) : elles ne viennent
   * pas d'un tour vocal, donc la ligne ne les prononce pas d'elle-même. Le
   * pont les reprend pour les dire.
   * @param {(text: string) => void} handler
   */
  onUnspokenReply(handler) {
    this.#onUnspokenReply = typeof handler === 'function' ? handler : null
  }

  /** La session d'appel, créée ou reprise à la première utilisation. */
  async ensure() {
    if (this.#handle !== undefined) return this.#handle.agent
    const agentOptions = this.#agentOptions()
    const preset = this.#presetOf()
    const setup = (agentCtx) => this.#setup(agentCtx, preset)
    const base = {
      sessionId: this.#sessionId,
      meta: { cwd: this.#config.agent.cwd ?? process.cwd(), ...(preset ? { agentPreset: preset } : {}) },
      agentOptions,
      setup,
    }
    try {
      this.#handle = await this.#ctx.agents.create(base)
    } catch (first) {
      this.#logger.info(`wazo-voice: création impossible (${messageOf(first)}), reprise de la session`)
      try {
        this.#handle = await this.#ctx.agents.resume({ resumeSessionId: this.#sessionId, agentOptions, setup })
      } catch (second) {
        this.#logger.warn(`wazo-voice: reprise impossible (${messageOf(second)}), session neuve`)
        this.#sessionId = `${this.#config.agent.sessionId}-${Date.now()}`
        this.#handle = await this.#ctx.agents.create({ ...base, sessionId: this.#sessionId, meta: { ...base.meta } })
      }
    }
    this.#installListener()
    this.#logger.info(`wazo-voice: session d'appel prête (${this.#sessionId})`)
    return this.#handle.agent
  }

  /**
   * Un tour de parole : l'énoncé entre, la réponse parlée sort.
   * Le tour est attendu par son événement `turn/end` : `whenIdle()` peut se
   * résoudre avant que le tour soumis ne commence.
   * @param {string} text énoncé transcrit
   * @returns {Promise<string>} dernier message texte de l'agent
   */
  async ask(text) {
    const agent = await this.ensure()
    this.#messages = []
    this.#lastTurnReason = null
    this.#lastError = null
    this.#turnActive = true
    const settled = new Promise((resolve) => { this.#turnSettled = resolve })
    // Un UserMessage complet : le pilote ne fabrique pas le rôle ni l'id.
    agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
    await withTimeout(settled, this.#config.agent.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS, 'aucun tour de l’agent (le pilote n’a pas démarré)')
    const reply = this.#messages.at(-1) ?? ''
    if (reply === '') {
      const reason = this.#lastTurnReason
      this.#lastError = reason?.kind === 'error'
        ? `tour en erreur: ${reason.error?.message ?? 'message inconnu'}`
        : `tour terminé sans texte (${reason?.kind ?? 'raison inconnue'})`
      this.#logger.warn(`wazo-voice: ${this.#lastError}`)
    }
    return reply
  }

  /** Diagnostic lisible dans `wazo_voice_status`. */
  info() {
    return {
      sessionId: this.#sessionId,
      ready: this.#handle !== undefined,
      lastTurnReason: this.#lastTurnReason,
      lastError: this.#lastError,
    }
  }

  /** Libère la session, la consigne et l'écoute du journal. */
  async dispose() {
    for (const dispose of this.#disposers.splice(0)) {
      try { dispose() } catch { /* déjà libéré */ }
    }
    this.#disposeListener?.()
    this.#disposeListener = undefined
    const handle = this.#handle
    this.#handle = undefined
    if (handle !== undefined) await handle.dispose().catch(() => {})
  }

  #agentOptions() {
    try {
      const selection = this.#ctx.agentDefaultModel?.currentSelection?.()
      if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
    } catch (error) {
      this.#logger.warn(`wazo-voice: sélection de modèle illisible — ${messageOf(error)}`)
    }
    return {}
  }

  #presetOf() {
    try {
      const session = this.#preferredCaller?.session
      if (session === undefined) return undefined
      return this.#ctx.agentPresets?.presetForSession?.(session) ?? undefined
    } catch {
      return undefined
    }
  }

  async #setup(agentCtx, preset) {
    try {
      const dispose = agentCtx?.systemPrompt?.section?.({
        name: 'wazo-voice-call',
        order: VOICE_SECTION_ORDER,
        text: () => VOICE_PROMPT,
      })
      if (typeof dispose === 'function') this.#disposers.push(dispose)
    } catch (error) {
      this.#logger.warn(`wazo-voice: consigne d'oralité non posée — ${messageOf(error)}`)
    }
    try {
      if (preset === undefined) await this.#ctx.agentPresets?.mount?.(agentCtx)
      else await this.#ctx.agentPresets?.mount?.(agentCtx, preset)
    } catch (error) {
      this.#logger.warn(`wazo-voice: preset non monté — ${messageOf(error)}`)
    }
  }

  #installListener() {
    this.#disposeListener?.()
    const sessionId = this.#sessionId
    this.#disposeListener = this.#ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId) return
      if (event.type === 'turn/end') {
        this.#lastTurnReason = event.data?.reason ?? null
        this.#turnActive = false
        const settle = this.#turnSettled
        this.#turnSettled = undefined
        settle?.()
        return
      }
      if (event.type !== 'assistant/message') return
      const text = textOfMessage(event.data?.message?.content)
      if (text === '') return
      if (!this.#turnActive) {
        // Tour venu d'un message écrit : personne ne l'a encore prononcé.
        try {
          this.#onUnspokenReply?.(text)
        } catch {
          /* la ligne ne doit pas casser le tour */
        }
        return
      }
      this.#messages.push(text)
    })
  }
}

function textOfMessage(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
