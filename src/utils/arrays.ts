export function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const size = Math.max(1, Math.floor(chunkSize));
  const result: T[][] = [];
  if (!Array.isArray(items) || items.length === 0) {
    return result;
  }
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}
