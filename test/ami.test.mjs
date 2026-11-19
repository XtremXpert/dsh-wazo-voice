import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { AmiClient, AmiError, parseAmiBlock } from '../lib/ami.js'

/** Serveur AMI de test : joue les réponses d'un Asterisk minimal. */
async function fakeAmi({ secret = 's3cret', originate = 'Success' } = {}) {
  const seen = []
  const server = net.createServer((socket) => {
    socket.write('Asterisk Call Manager/5.0.3\r\n')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let boundary
      while ((boundary = buffer.indexOf('\r\n\r\n')) >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 4)
        const fields = parseAmiBlock(block)
        seen.push(fields)
        if (fields.Action === 'Login') {
          const ok = fields.Secret === secret
          socket.write(`Response: ${ok ? 'Success' : 'Error'}\r\nMessage: ${ok ? 'Authentication accepted' : 'Authentication failed'}\r\n\r\n`)
        } else if (fields.Action === 'Originate') {
          socket.write(`Response: ${originate}\r\nMessage: ${originate === 'Success' ? 'Originate successfully queued' : 'No such context'}\r\nActionID: ${fields.ActionID}\r\n\r\n`)
        } else if (fields.Action === 'Hangup') {
          socket.write('Response: Success\r\n\r\n')
        }
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, seen }
}

test('parseAmiBlock décode les paires clé/valeur', () => {
  const fields = parseAmiBlock('Response: Success\r\nActionID: 42\r\nMessage: a: b')
  assert.deepEqual(fields, { Response: 'Success', ActionID: '42', Message: 'a: b' })
})

test('AmiClient se connecte et authentifie', async () => {
  const ami = await fakeAmi()
  try {
    const client = await AmiClient.connect({ host: '127.0.0.1', port: ami.port, user: 'dsh', secret: 's3cret' })
    assert.equal(ami.seen[0].Action, 'Login')
    client.close()
  } finally {
    ami.server.close()
  }
})

test('AmiClient refuse un secret erroné', async () => {
  const ami = await fakeAmi()
  try {
    await assert.rejects(
      AmiClient.connect({ host: '127.0.0.1', port: ami.port, user: 'dsh', secret: 'faux' }),
      (error) => error instanceof AmiError && /refusée/.test(error.message),
    )
  } finally {
    ami.server.close()
  }
})

test('AmiClient origine un canal et raccroche', async () => {
  const ami = await fakeAmi()
  try {
    const client = await AmiClient.connect({ host: '127.0.0.1', port: ami.port, user: 'dsh', secret: 's3cret' })
    const response = await client.originate({ channel: 'PJSIP/1000', context: 'dsh-bridge', exten: 's', callerId: 'DSH <1099>' })
    assert.equal(response.Response, 'Success')
    const originate = ami.seen.find((fields) => fields.Action === 'Originate')
    assert.equal(originate.Channel, 'PJSIP/1000')
    assert.equal(originate.Context, 'dsh-bridge')
    assert.equal(originate.Async, 'true')
    await client.hangup('PJSIP/1000')
    assert.ok(ami.seen.some((fields) => fields.Action === 'Hangup'))
    client.close()
  } finally {
    ami.server.close()
  }
})

test('AmiClient origine par Application/Data, sans contexte', async () => {
  const ami = await fakeAmi()
  try {
    const client = await AmiClient.connect({ host: '127.0.0.1', port: ami.port, user: 'dsh', secret: 's3cret' })
    await client.originate({ channel: 'PJSIP/1000', application: 'AudioSocket', data: 'uuid,127.0.0.1:8092' })
    const originate = ami.seen.find((fields) => fields.Action === 'Originate')
    assert.equal(originate.Application, 'AudioSocket')
    assert.equal(originate.Data, 'uuid,127.0.0.1:8092')
    assert.equal(originate.Context, undefined)
    client.close()
  } finally {
    ami.server.close()
  }
})

test('AmiClient remonte un Originate refusé', async () => {
  const ami = await fakeAmi({ originate: 'Error' })
  try {
    const client = await AmiClient.connect({ host: '127.0.0.1', port: ami.port, user: 'dsh', secret: 's3cret' })
    await assert.rejects(
      client.originate({ channel: 'PJSIP/1000', context: 'inexistant', exten: 's' }),
      (error) => error instanceof AmiError && /Originate refusé/.test(error.message),
    )
    client.close()
  } finally {
    ami.server.close()
  }
})
