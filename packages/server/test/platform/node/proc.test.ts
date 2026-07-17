import { describe, expect, it } from 'vitest'
import { NodeProcess } from '../../../src/platform/node/proc.js'

describe('NodeProcess', () => {
  it('checks the supplied executable command without an agent map', async () => {
    const processPort = new NodeProcess()
    await expect(processPort.isCommandInstalled('git')).resolves.toBe(true)
    await expect(
      processPort.isCommandInstalled('loom-command-that-does-not-exist-7f3d2a'),
    ).resolves.toBe(false)
  })
})
