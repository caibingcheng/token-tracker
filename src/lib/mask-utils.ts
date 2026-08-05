export function maskVirtualKey(plain: string): string {
  if (!plain) return "";
  if (plain.length <= 10) return `${plain.slice(0, 2)}***`;
  return `${plain.slice(0, 6)}***${plain.slice(-4)}`;
}
