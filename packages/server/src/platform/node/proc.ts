import { execFileSync } from 'node:child_process'
import type { IProcess } from '../../ports/process.js'

export class NodeProcess implements IProcess {
  async isInstalled(agentId: string): Promise<boolean> {
    const map: Record<string, string> = { 'claude-code': 'claude', 'codex': 'codex', 'opencode': 'opencode' }
    const bin = map[agentId]
    if (!bin) return false
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}
