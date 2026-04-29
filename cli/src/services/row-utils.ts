export function mergeRowsById<Row extends { id: bigint }>(...rowGroups: Row[][]): Row[] {
  const byId = new Map<bigint, Row>();
  for (const rows of rowGroups) {
    for (const row of rows) {
      byId.set(row.id, row);
    }
  }
  return Array.from(byId.values());
}
