// Connectivity + handshake probe for a Minecraft java server.
// MODE=status  -> server list ping only
// MODE=login   -> full offline login, then exit (prints what the server sent)
// MODE=stay    -> login and keep the session alive for STAY_MIN minutes
//
// Plain protocol implementation, no game logic: it only answers keepalive and
// teleport confirmations, and never sends movement packets.

const net = require('net')
const mc = require('minecraft-protocol')

const HOST = process.env.MC_HOST
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const USERNAME = process.env.MC_USER || 'bot_' + Math.random().toString(36).slice(2, 8)
const VERSION = process.env.MC_VERSION || '1.21.4'
const MODE = process.env.MODE || 'status'
const STAY_MS = parseInt(process.env.STAY_MIN || '30', 10) * 60 * 1000

function log (...a) { console.log(new Date().toISOString(), ...a) }

function varint (n) {
  const out = []
  let v = n >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return Buffer.from(out)
}
function mcString (s) {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([varint(b.length), b])
}
function mcPacket (id, payload) {
  const body = Buffer.concat([varint(id), payload])
  return Buffer.concat([varint(body.length), body])
}

function statusPing () {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(PORT, HOST)
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('ping timeout')) }, 15000)
    let buf = Buffer.alloc(0)
    sock.on('connect', () => {
      log('tcp connected to', HOST + ':' + PORT)
      const hs = mcPacket(0x00, Buffer.concat([
        varint(769),
        mcString(HOST),
        Buffer.from([(PORT >> 8) & 0xff, PORT & 0xff]),
        varint(1)
      ]))
      sock.write(Buffer.concat([hs, mcPacket(0x00, Buffer.alloc(0))]))
    })
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      try {
        let off = 0
        const rv = () => {
          let num = 0; let shift = 0; let b
          do { b = buf[off++]; num |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80)
          return num
        }
        const len = rv()
        if (buf.length < off + len) return
        rv()
        const slen = rv()
        const json = buf.slice(off, off + slen).toString('utf8')
        clearTimeout(timer)
        sock.destroy()
        resolve(JSON.parse(json))
      } catch { /* partial frame, wait for more */ }
    })
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

// Raw login attempt: handshake(next=2) + login start, log every packet id seen.
function rawLogin (seconds) {
  return new Promise((resolve) => {
    const sock = net.createConnection(PORT, HOST)
    const events = []
    const timer = setTimeout(() => { events.push('timeout'); try { sock.destroy() } catch {} ; resolve(events) }, seconds * 1000)
    let buf = Buffer.alloc(0)

    const readVarInt = (b, o) => {
      let num = 0; let shift = 0; let by
      do { by = b[o++]; num |= (by & 0x7f) << shift; shift += 7 } while (by & 0x80)
      return [num, o]
    }

    sock.on('connect', () => {
      const hs = mcPacket(0x00, Buffer.concat([
        varint(769),
        mcString(HOST),
        Buffer.from([(PORT >> 8) & 0xff, PORT & 0xff]),
        varint(2)
      ]))
      const ls = mcPacket(0x00, mcString(USERNAME))
      sock.write(Buffer.concat([hs, ls]))
      events.push('sent handshake+loginstart')
    })
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      let off = 0
      try {
        while (off + 1 < buf.length) {
          const [len, o1] = readVarInt(buf, off)
          if (buf.length < o1 + len) break
          const [id, o2] = readVarInt(buf, o1)
          events.push('packet id=0x' + id.toString(16) + ' len=' + len + ' head=' + buf.slice(o2, Math.min(o2 + 24, o1 + len)).toString('hex'))
          off = o1 + len
          if (id === 0x02 || id === 0x00) { clearTimeout(timer); sock.destroy(); resolve(events); return }
        }
        buf = buf.slice(off)
      } catch { /* partial */ }
    })
    sock.on('error', (e) => { events.push('error:' + e.message); clearTimeout(timer); resolve(events) })
    sock.on('close', () => { clearTimeout(timer); resolve(events) })
  })
}

async function stay () {
  const client = mc.createClient({
    host: HOST,
    port: PORT,
    username: USERNAME,
    auth: 'offline',
    version: VERSION,
    closeTimeout: 60 * 1000
  })
  let done = false
  const finish = (code, msg) => {
    if (done) return
    done = true
    log(msg)
    try { client.end() } catch {}
    setTimeout(() => process.exit(code), 500)
  }

  client.on('login', () => {
    log('logged in as', USERNAME)
    setTimeout(() => finish(0, 'stay complete'), STAY_MS)
    setTimeout(() => finish(1, 'hard timeout'), STAY_MS + 4 * 60 * 1000)
  })
  client.on('position', (p) => {
    try { client.write('teleport_confirm', { teleportId: p.teleportId }) } catch {}
    log('spawned; staying', STAY_MS / 60000, 'min')
  })
  client.on('kick_disconnect', (p) => finish(1, 'kicked: ' + JSON.stringify(p && p.reason)))
  client.on('disconnect', (p) => finish(1, 'disconnected: ' + JSON.stringify(p && p.reason)))
  client.on('error', (e) => finish(1, 'error: ' + (e && e.message)))
  client.on('end', () => { if (!done) finish(1, 'connection ended early') })
}

async function main () {
  log('mode=' + MODE, 'target=' + HOST + ':' + PORT, 'version=' + VERSION)
  try {
    const st = await statusPing()
    log('status ok:', JSON.stringify({
      version: st.version && st.version.name,
      protocol: st.version && st.version.protocol,
      online: st.players && st.players.online,
      max: st.players && st.players.max,
      motd: st.description
    }))
  } catch (e) {
    log('status ping FAILED:', e.message)
    if (MODE === 'status') process.exit(1)
  }

  if (MODE === 'login') {
    const ev = await rawLogin(parseInt(process.env.LOGIN_WAIT || '20', 10))
    ev.forEach((x) => log('  login>', x))
    process.exit(0)
  }
  if (MODE === 'stay') return stay()
  process.exit(0)
}

main()
