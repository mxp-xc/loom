export function skillFolderDisplayPath(skillFilePath: string): string {
  return skillFilePath.replace(/\\/g, '/').replace(/\/SKILL\.md$/, '')
}
