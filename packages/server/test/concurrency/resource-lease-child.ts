import { createInterface } from 'node:readline'
import { ResourceLeaseCoordinator } from '../../src/concurrency/resource-lease-coordinator.js'

const key = process.argv[2]
if (!key) throw new Error('resource key is required')

let entered = false
let release!: () => void
const released = new Promise<void>((resolve) => {
  release = resolve
})
const leases = new ResourceLeaseCoordinator()
const operation = leases.runMutation([key], async () => {
  entered = true
  process.stdout.write('entered\n')
  await released
})

process.stdout.write('requested\n')
const input = createInterface({ input: process.stdin })
input.on('line', (command) => {
  if (command === 'check') process.stdout.write(`checked:${entered}\n`)
  if (command === 'release') release()
})

await operation
input.close()
process.stdout.write('completed\n')
