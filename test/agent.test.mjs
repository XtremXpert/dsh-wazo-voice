import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentBridge } from '../lib/agent.js'
import { resolveConfig } from '../lib/config.js'

const silent = { info() {}, warn() {}, error() {} }

/** Hôte minimal : un agent piloté, des événements de session rejoués à la main. */
function fakeHost({ reply = 'Bonjour.', reason = { kind: 'completed' } } = {}) {
  const handlers = []
  const received = []
  const created = []
  const agent = {
    id: 'wazo-voice',
    session: { id: 'wazo-voice' },
    followup(message) {
      received.push(message)
      for (const handler of handlers) {
        handler({ id: 'wazo-voice' }, {
          type: 'assistant/message',
          data: { message: { content: reply === '' ? [] : [{ type: 'text', text: reply }] } },
        })
        handler({ id: 'wazo-voice' }, { type: 'turn/end', data: { reason } })
      }
    },
  }
  const ctx = {
    logger: silent,
    on(_event, handler) {
      handlers.push(handler)
      return () => { handlers.splice(handlers.indexOf(handler), 1) }
    },
    agents: {
      async create(options) {
        created.push(options)
        await options.setup?.(ctx, agent)
        return { agent, dispose: async () => {} }
      },
      async resume() { throw new Error('pas de session') },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) },
    agentPresets: { presetForSession: () => 'standard', mount: async () => {} },
    systemPrompt: { section: () => () => {} },
  }
  return { ctx, agent, received, created, handlers }
}

test('ask envoie un UserMessage complet et rend le texte du tour', async () => {
  const host = fakeHost({ reply: 'Il est midi.' })
  const bridge = new AgentBridge({ ctx: host.ctx, config: resolveConfig({ ports: [0] }), logger: silent })
  try {
    const reply = await bridge.ask('Quelle heure est-il ?')
    assert.equal(reply, 'Il est midi.')
    const message = host.received[0]
    assert.equal(message.role, 'user')
    assert.equal(typeof message.id, 'string')
    assert.deepEqual(message.source, { kind: 'user' })
    assert.deepEqual(message.content, [{ type: 'text', text: 'Quelle heure est-il ?' }])
    assert.equal(bridge.info().ready, true)
  } finally {
    await bridge.dispose()
  }
})

test('ask rapporte un tour terminé en erreur au lieu d’un silence', async () => {
  const host = fakeHost({ reply: '', reason: { kind: 'error', error: { message: 'quota dépassé' } } })
  const bridge = new AgentBridge({ ctx: host.ctx, config: resolveConfig({ ports: [0] }), logger: silent })
  try {
    const reply = await bridge.ask('Bonjour ?')
    assert.equal(reply, '')
    assert.match(bridge.info().lastError, /quota dépassé/)
  } finally {
    await bridge.dispose()
  }
})

test('ask nomme une fin de tour sans texte', async () => {
  const host = fakeHost({ reply: '', reason: { kind: 'aborted', reason: { kind: 'user' } } })
  const bridge = new AgentBridge({ ctx: host.ctx, config: resolveConfig({ ports: [0] }), logger: silent })
  try {
    assert.equal(await bridge.ask('Allô ?'), '')
    assert.match(bridge.info().lastError, /sans texte \(aborted\)/)
  } finally {
    await bridge.dispose()
  }
})
