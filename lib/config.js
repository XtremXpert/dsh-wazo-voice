/**
 * Configuration du pont vocal : valeurs par défaut de cette installation,
 * fusionnées avec la config de la rangée `wazo-voice` du profil.
 *
 * Le paquet n'exporte pas de `Config` (aucune dépendance vers
 * `@deepseek-ai/schemastery` depuis un bundle local) : `resolveConfig`
 * normalise et documente donc les valeurs, et `apply` reçoit le résultat.
 */

/** Valeurs par défaut : Wazo Maison, ASR Whisper et TTS Kokoro locaux. */
export const DEFAULTS = {
  /** Adresse d'écoute AudioSocket (celle que le plan de numérotation appelle). */
  bind: '0.0.0.0',
  /**
   * Ports d'écoute. Le plan de numérotation déployé appelle 8090 (sauvegarde
   * du dépôt) ou 8092 (pont Python historique) : écouter les deux évite de
   * deviner. Un port occupé est signalé et n'empêche pas les autres.
   */
  ports: [8092, 8090],
  /** Fréquence du canal AudioSocket (`slin` Asterisk = 8 kHz, 16 bits, mono). */
  sampleRate: 8000,
  asr: {
    url: 'http://127.0.0.1:9030/',
    language: 'fr',
    timeoutMs: 60000,
  },
  tts: {
    provider: 'kokoro',
    url: 'http://127.0.0.1:9032/synthesize',
    voice: 'ff_siwis',
    speed: 1,
    sayVoice: 'Amelie',
    timeoutMs: 90000,
    fallbackToSay: true,
  },
  vad: {
    /** Énergie RMS minimale (échelle int16) pour considérer qu'on parle. */
    threshold: 450,
    endSilenceMs: 600,
    minSpeechMs: 300,
    maxUtteranceMs: 30000,
    preRollMs: 300,
  },
  agent: {
    sessionId: 'wazo-voice',
    cwd: undefined,
    replyTimeoutMs: 120000,
  },
  greet: {
    inbound: '',
    outbound: 'Bonjour, je vous écoute.',
  },
  ami: {
    host: '192.168.234.60',
    port: 5038,
    user: 'dsh',
    /** Nom d'environnement résolu par `credentials.resolve` (jamais en clair). */
    secretRef: 'WAZO_AMI_SECRET',
    channelTemplate: 'PJSIP/{to}',
    /**
     * Application exécutée sur le canal composé : `AudioSocket` évite de
     * dépendre d'un contexte du plan de numérotation (un seul canal, pas de
     * pont). Mettre `''` pour revenir à `Context`/`Exten`.
     */
    application: 'AudioSocket',
    /**
     * Adresse que le PBX doit joindre pour ouvrir l'AudioSocket. Vide =
     * détection par la route vers `ami.host`.
     */
    advertiseHost: undefined,
    context: 'dsh-bridge',
    exten: 's',
    callerId: 'DSH <1099>',
    timeoutMs: 30000,
  },
  /** Musique d'attente pendant la réflexion de l'agent (`file` vide = boucle synthétisée). */
  holdMusic: {
    enabled: true,
    file: '',
    volume: 0.18,
  },
  /** Durée maximale d'un appel, garde-fou d'un appel oublié. */
  maxCallMs: 1800000,
  maxQueuedTurns: 2,
}

/** Fusion récursive (objets simples uniquement) des surcharges sur les défauts. */
export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return base
  const merged = { ...base }
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isPlainObject(value) && isPlainObject(base[key])
      ? mergeConfig(base[key], value)
      : value
  }
  return merged
}

/** Configuration effective : défauts, surcharges, puis normalisations minimales. */
export function resolveConfig(raw = {}) {
  const config = mergeConfig(DEFAULTS, raw)
  config.ports = normalizePorts(config.ports)
  config.sampleRate = positiveInt(config.sampleRate, DEFAULTS.sampleRate)
  return config
}

/** Liste de ports distincts et valides, dans l'ordre donné (0 = port éphémère, tests). */
export function normalizePorts(value) {
  const list = Array.isArray(value) ? value : [value]
  const ports = []
  for (const item of list) {
    const port = Number(item)
    if (Number.isInteger(port) && port >= 0 && port <= 65535 && !ports.includes(port)) ports.push(port)
  }
  return ports.length > 0 ? ports : [...DEFAULTS.ports]
}

/** Chaîne de configuration prête pour l'appel sortant (`{to}` remplacé). */
export function outboundChannel(ami, to) {
  if (typeof to !== 'string' || to.trim() === '') throw new Error('numéro ou canal requis')
  const target = to.trim()
  // Un canal explicite (`PJSIP/1000`, `Local/…`) est passé tel quel.
  if (target.includes('/')) return target
  return String(ami.channelTemplate ?? 'PJSIP/{to}').replaceAll('{to}', target)
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
