/** Private compatibility process: prove this PID bound the selected loopback listener. */
import { Server } from 'node:http'
const nonce = process.env.PKW_COMPAT_BIND_NONCE
const port = Number(process.env.PKW_COMPAT_BIND_PORT)
if (!/^[a-f0-9]{48}$/.test(nonce ?? '') || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PKW_COMPAT_PROOF_CONFIGURATION')
}
const listen = Server.prototype.listen
Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address()
    if (address && typeof address === 'object' && address.address === '127.0.0.1' && address.port === port) {
      process.stdout.write(JSON.stringify({ status: 'PKW_COMPAT_OWNED_BIND', nonce, pid: process.pid, port, address: address.address }) + '\n')
    }
  })
  return Reflect.apply(listen, this, args)
}
