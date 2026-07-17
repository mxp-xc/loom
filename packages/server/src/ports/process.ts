export interface IProcess {
  isCommandInstalled(command: string): Promise<boolean>
}
