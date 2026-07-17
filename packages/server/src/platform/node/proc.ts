import { execFileSync } from 'node:child_process'
import type { IProcess } from '../../ports/process.js'

export class NodeProcess implements IProcess {
  async isCommandInstalled(command: string): Promise<boolean> {
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}
