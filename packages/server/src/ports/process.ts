export interface IProcess {
  isInstalled(agentId: string): Promise<boolean>
}
