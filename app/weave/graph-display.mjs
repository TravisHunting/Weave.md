const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const source = edge => edge.source_document_id || edge.from;
const kind = edge => edge.type || edge.relationship_type || 'links-to';
const position = value => Number.isFinite(value) && value >= 0 ? value : null;

function authoredOrder(a, b) {
  const sourceOrder = compareText(source(a), source(b));
  if (sourceOrder) return sourceOrder;
  const aOffset = position(a.start_offset), bOffset = position(b.start_offset);
  if (aOffset !== null && bOffset !== null && aOffset !== bOffset) return aOffset - bOffset;
  const aLine = position(a.source_line), bLine = position(b.source_line);
  if (aLine !== null && bLine !== null && aLine !== bLine) return aLine - bLine;
  // Prefer explicit source positions when older/imported data lacks them. IDs
  // only break ties; their string order never overrides authored positions.
  return (aLine ?? Infinity) - (bLine ?? Infinity)
    || (aOffset ?? Infinity) - (bOffset ?? Infinity)
    || compareText(String(a.id), String(b.id));
}

/** Choose one visual arrow per unordered node pair. The records and the input
 * graph retain every authored relationship for traversal, evidence and details. */
export function displayGraphRelationships(edges, activeArticle) {
  const pairs = new Map();
  for (const edge of edges) {
    const key = JSON.stringify([edge.from, edge.to].sort(compareText));
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(edge);
  }
  return [...pairs.values()].map(records => {
    const named = records.filter(edge => kind(edge) !== 'links-to');
    const preferred = named.length ? named : records;
    const authoredHere = named.filter(edge => source(edge) === activeArticle);
    const representative = [...(authoredHere.length ? authoredHere : preferred)].sort(authoredOrder)[0];
    return {...representative, type: kind(representative), records};
  });
}
