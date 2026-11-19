/**
 * Journal borné du plugin, consultable par `wazo_voice_status`.
 *
 * Le journal du hôte n'est pas lisible depuis la session : garder les
 * dernières lignes en mémoire rend le diagnostic possible sans redémarrage.
 */

const DEFAULT_LIMIT = 80

/**
 * Enveloppe un logger de hôte en gardant les dernières lignes.
 * @param {{info?: Function, warn?: Function, error?: Function}} hostLogger
 * @param {number} limit nombre de lignes conservées
 */
export function createRecorder(hostLogger, limit = DEFAULT_LIMIT) {
  const lines = []
  const record = (level) => (...args) => {
    const text = args.map((value) => (typeof value === 'string' ? value : stringify(value))).join(' ')
    lines.push(`${new Date().toISOString().slice(11, 19)} ${level} ${text}`)
    if (lines.length > limit) lines.shift()
    try {
      hostLogger?.[level]?.(...args)
    } catch {
      // un logger de hôte défaillant ne doit pas couper un appel
    }
  }
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    lines: () => [...lines],
  }
}

function stringify(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
