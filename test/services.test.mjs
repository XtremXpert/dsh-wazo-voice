import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { transcribe } from '../lib/asr.js'
import { synthesize } from '../lib/tts.js'

function tone(samples, amplitude = 1200, sampleRate = 8000) {
  const buffer = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * index) / sampleRate)), index * 2)
  }
  return buffer
}

function wav(sampleRate, samples) {
  const data = tone(samples, 1200, sampleRate)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** Serveur HTTP de test : capture la requête et répond par `respond`. */
async function serve(respond) {
  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      requests.push({ url: request.url, headers: request.headers, body })
      respond(response, body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, requests }
}

test('transcribe envoie le PCM brut et lit le texte', async () => {
  const service = await serve((response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ text: '  Bonjour tout le monde  ', seconds: 1.2 }))
  })
  try {
    const pcm = tone(1600)
    const result = await transcribe(pcm, { url: `http://127.0.0.1:${service.port}/`, language: 'fr', timeoutMs: 5000 })
    assert.equal(result.text, 'Bonjour tout le monde')
    assert.equal(result.seconds, 1.2)
    assert.equal(service.requests[0].url, '/?language=fr')
    assert.equal(service.requests[0].headers['content-type'], 'application/octet-stream')
    assert.equal(service.requests[0].body.length, pcm.length)
  } finally {
    service.server.close()
  }
})

test('transcribe remonte une panne du service', async () => {
  const service = await serve((response) => {
    response.statusCode = 503
    response.end('modèle en cours de chargement')
  })
  try {
    await assert.rejects(
      transcribe(tone(160), { url: `http://127.0.0.1:${service.port}/`, timeoutMs: 5000 }),
      /ASR 503/,
    )
  } finally {
    service.server.close()
  }
})

test('synthesize ramène le WAV 24 kHz au PCM 8 kHz', async () => {
  const service = await serve((response) => {
    response.setHeader('content-type', 'audio/wav')
    response.end(wav(24000, 2400))
  })
  try {
    const result = await synthesize('Bonjour.', {
      provider: 'kokoro',
      url: `http://127.0.0.1:${service.port}/synthesize`,
      voice: 'ff_siwis',
      sampleRate: 8000,
      timeoutMs: 5000,
    })
    assert.equal(result.source, 'kokoro')
    assert.equal(result.pcm.length, 800 * 2)
    assert.equal(service.requests[0].url, '/synthesize')
    assert.deepEqual(JSON.parse(service.requests[0].body.toString()), { text: 'Bonjour.', voice: 'ff_siwis', speed: 1 })
  } finally {
    service.server.close()
  }
})

test('synthesize nettoie le markdown avant de parler', async () => {
  const service = await serve((response) => {
    response.setHeader('content-type', 'audio/wav')
    response.end(wav(8000, 160))
  })
  try {
    await synthesize('**Bonjour** `monde`', {
      provider: 'kokoro',
      url: `http://127.0.0.1:${service.port}/synthesize`,
      sampleRate: 8000,
      timeoutMs: 5000,
    })
    assert.equal(JSON.parse(service.requests[0].body.toString()).text, 'Bonjour monde')
  } finally {
    service.server.close()
  }
})
