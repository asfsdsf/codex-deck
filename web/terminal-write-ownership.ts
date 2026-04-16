export function shouldAutoClaimWriteAfterRestart(
  writeOwnerId: string | null,
  clientId: string,
): boolean {
  return writeOwnerId === null || writeOwnerId === clientId;
}
