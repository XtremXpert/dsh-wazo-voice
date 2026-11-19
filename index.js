/**
 * `@local/dsh-wazo-voice` — discuter en vocal avec un humain par un PBX Wazo.
 *
 * Inbound : le plan de numérotation appelle `AudioSocket(uuid, hôte:port)` ;
 * ce plugin écoute, transcrit, réveille la session d'appel et fait parler la
 * réponse. Outbound : `wazo_voice_call` compose par AMI, le plan de
 * numérotation répond puis ouvre l'AudioSocket, et la conversation suit.
 *
 * Le plugin n'embarque ni modèle ni secret : ASR et TTS sont des services
 * locaux, et le secret AMI est résolu à chaque appel par `credentials`.
 */

import * as asr from './lib/asr.js'
import * as tts from './lib/tts.js'
import { AgentBridge } from './lib/agent.js'
import { VoiceBridge } from './lib/bridge.js'
import { resolveConfig } from './lib/config.js'
import { readWavPcm16 } from './lib/hold-music.js'
import { createRecorder } from './lib/log.js'

/** Nom du plugin. */
export const name = 'wazo-voice'

/** Services du hôte nécessaires à l'enregistrement des outils. */
export const inject = ['tools', 'agents', 'agentPresets', 'agentDefaultModel']

/**
 * Monte le pont vocal et ses outils.
 * @param {object} ctx contexte du hôte
 * @param {object} rawConfig config de la rangée `wazo-voice`
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const logger = createRecorder(ctx.logger)
  const agents = new AgentBridge({ ctx, config, logger })
  const asrConfig = { ...config.asr }
  const ttsConfig = { ...config.tts, sampleRate: config.sampleRate }

  const resolveSecret = async () => {
    const ref = config.ami.secretRef
    try {
      const credentials = ctx.get('credentials')
      const resolved = await credentials?.resolve(ref)
      if (resolved?.value) return resolved
    } catch (error) {
      logger.warn(`wazo-voice: secret AMI illisible — ${messageOf(error)}`)
    }
    if (typeof config.ami.secret === 'string' && config.ami.secret !== '') {
      return { value: config.ami.secret, source: 'config' }
    }
    return undefined
  }

  const services = {
    asr: { transcribe: (pcm) => asr.transcribe(pcm, asrConfig) },
    tts: { synthesize: (text) => tts.synthesize(text, ttsConfig) },
    agents,
  }
  const bridge = new VoiceBridge({ config, logger, services, resolveSecret })

  // Une réponse tapée dans la conversation doit aussi s'entendre sur la ligne :
  // l'agent parle et écrit dans la même conversation, l'humain garde les deux.
  agents.onUnspokenReply((text) => {
    bridge.announce(text).catch((error) => logger.warn(`wazo-voice: réponse écrite non dite — ${messageOf(error)}`))
  })

  ctx.effect(() => {
    bridge.start().catch((error) => logger.warn(`wazo-voice: démarrage incomplet — ${messageOf(error)}`))
    return async () => {
      await bridge.stop().catch(() => {})
      await agents.dispose()
    }
  })

  const status = async () => {
    const [asrHealth, ttsHealth, secret] = await Promise.all([
      asr.probe(asrConfig),
      tts.probe(ttsConfig),
      describeSecret(ctx, config.ami.secretRef),
    ])
    return {
      ...bridge.status(),
      agent: agents.info(),
      services: { asr: asrHealth, tts: ttsHealth },
      log: logger.lines().slice(-30),
      ami: {
        host: config.ami.host,
        port: config.ami.port,
        user: config.ami.user,
        context: config.ami.context,
        channelTemplate: config.ami.channelTemplate,
        secret,
      },
    }
  }

  ctx.tools.register({
    name: 'wazo_voice_status',
    description:
      'État de la ligne vocale Wazo : ports AudioSocket écoutés, appel en cours, dernier appel, disponibilité de la transcription et de la synthèse, et présence du secret AMI.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: outputSchema(),
    async execute() {
      return await status()
    },
  })

  ctx.tools.register({
    name: 'wazo_voice_call',
    description:
      'Appelle un poste par Wazo et parle à la personne qui décroche. À utiliser aussi pour rappeler un humain qui a demandé un rappel. Le décrochage se vérifie ensuite avec wazo_voice_status.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Extension ou numéro à composer (ex. « 1000 »), ou un canal explicite (ex. « PJSIP/1000 »).' },
        opening: { type: 'string', description: 'Phrase prononcée dès le décrochage, avant toute réponse de l’humain. Par défaut, l’accueil configuré.' },
      },
      required: ['to'],
      additionalProperties: false,
    },
    output: outputSchema(),
    async execute(args, exec) {
      agents.setPreferredCaller(exec?.agent)
      return await bridge.call({ to: args?.to, opening: args?.opening })
    },
  })

  ctx.tools.register({
    name: 'wazo_voice_hangup',
    description: 'Raccroche l’appel vocal Wazo en cours. À n’utiliser qu’après des adieux clairs.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: outputSchema(),
    async execute() {
      const requested = bridge.hangup()
      return { requested, note: requested > 0 ? 'La phrase en cours est dite, puis la ligne est coupée.' : 'Aucun appel en cours.' }
    },
  })

  ctx.tools.register({
    name: 'wazo_voice_say',
    description:
      'Fait dire une phrase sur l’appel en cours, sans passer par l’agent : utile pour annoncer une attente pendant une recherche longue.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Phrase à prononcer, courte et sans markdown.' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: outputSchema(),
    async execute(args) {
      const audio = await bridge.say(args?.text)
      return { spoken: true, source: audio.source, sampleRate: audio.sampleRate }
    },
  })

  ctx.tools.register({
    name: 'wazo_voice_play',
    description:
      'Fait écouter sur l’appel en cours un extrait d’un fichier WAV PCM 16 bits mono à la fréquence du canal, sans passer par la synthèse : utile pour une musique ou une ambiance.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Chemin du WAV à jouer (PCM 16 bits mono, 8 kHz).' },
        seconds: { type: 'number', description: 'Durée de l’extrait en secondes (20 par défaut, 300 au plus).' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: outputSchema(),
    async execute(args) {
      const path = typeof args?.file === 'string' ? args.file.trim() : ''
      if (path === '') throw new Error('fichier requis')
      const pcm = readWavPcm16(path, config.sampleRate)
      if (pcm === null) throw new Error('WAV illisible : PCM 16 bits mono à la fréquence du canal attendu')
      const asked = Number(args?.seconds)
      const seconds = Number.isFinite(asked) && asked > 0 ? Math.min(300, asked) : 20
      const bytes = Math.min(pcm.length, Math.round(seconds * config.sampleRate) * 2)
      await bridge.play(pcm.subarray(0, bytes))
      return { played: path, seconds: Math.round(bytes / 2 / config.sampleRate) }
    },
  })

  ctx.tools.register({
    name: 'wazo_voice_configure',
    description:
      'Enregistre le secret AMI du PBX Wazo dans le magasin de justificatifs du harnais, pour que wazo_voice_call puisse composer. Le secret n’est jamais écrit dans la configuration du plugin.',
    parameters: {
      type: 'object',
      properties: {
        amiSecret: { type: 'string', description: 'Secret AMI (utilisateur configuré, par défaut « dsh »). Laisse vide pour oublier le secret.' },
      },
      additionalProperties: false,
    },
    output: outputSchema(),
    async execute(args) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new Error('le service de justificatifs n’est pas disponible dans ce profil')
      const ref = config.ami.secretRef
      const value = typeof args?.amiSecret === 'string' ? args.amiSecret.trim() : ''
      if (value === '') {
        await credentials.unset(ref)
        return { ref, configured: false }
      }
      await credentials.set(ref, value)
      const info = await credentials.describe(ref).catch(() => ({ configured: true }))
      return { ref, configured: info.configured ?? true, source: info.source ?? null, masked: info.masked ?? null }
    },
  })
}

async function describeSecret(ctx, ref) {
  try {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return { configured: false, reason: 'service indisponible' }
    const info = await credentials.describe(ref)
    return { configured: info.configured, source: info.source ?? null, writable: info.writable ?? null, masked: info.masked ?? null }
  } catch (error) {
    return { configured: false, error: messageOf(error) }
  }
}

function outputSchema() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
