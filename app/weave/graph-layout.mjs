// Lay out each relationship depth in short columns, reserving separate horizontal
// space for every depth so an overflowing column cannot overlap the next one.
export function layoutColumns(buckets, columnWidth, rowHeight, {overview = false, maxRows = 5} = {}) {
  const positions = new Map();
  const place = (nodes, firstColumn, direction) => {
    const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const columns = Math.ceil(sorted.length / maxRows), rows = Math.floor(sorted.length / columns), extra = sorted.length % columns;
    let offset = 0;
    for (let column = 0; column < columns; column++) {
      const count = rows + (column < extra ? 1 : 0), group = sorted.slice(offset, offset + count);offset += count;
      group.forEach((node, row) => positions.set(node.id, {
        x: (firstColumn + column * direction) * columnWidth,
        y: (row - (group.length - 1) / 2) * rowHeight
      }));
    }
    return columns;
  };
  if (overview) {
    let column = 0;
    for (const [, nodes] of [...buckets].sort(([a], [b]) => a - b)) column += place(nodes, column, 1);
  } else {
    place(buckets.get(0) || [], 0, 1);
    for (const direction of [-1, 1]) {
      let column = direction;
      const groups = [...buckets].filter(([depth]) => Math.sign(depth) === direction).sort(([a], [b]) => Math.abs(a) - Math.abs(b));
      for (const [, nodes] of groups) column += direction * place(nodes, column, direction);
    }
  }
  return positions;
}

// Scatter the other nodes semi-randomly around the active article, which stays
// at the origin. Each node takes a random angle and distance, retrying further
// out when it would overlap a placed node, so the result is a loose cluster
// rather than columns. `width`/`height` are the minimum centre separations.
export function shufflePositions(positions, focus, random = Math.random, {width = 300, height = 130} = {}) {
  const ids = [...positions.keys()].filter(id => id !== focus);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const placed = [{x: 0, y: 0}], result = new Map(), free = (x, y) => placed.every(p => Math.abs(p.x - x) >= width || Math.abs(p.y - y) >= height);
  let reach = 1.2;
  for (const id of ids) {
    let spot = null;
    for (let attempt = 0; attempt < 400 && !spot; attempt++) {
      const angle = random() * Math.PI * 2, distance = .8 + random() * reach;
      const x = Math.round(Math.cos(angle) * distance * width), y = Math.round(Math.sin(angle) * distance * height * 1.6);
      if (free(x, y)) spot = {x, y};
      else if (attempt % 20 === 19) reach += .4;
    }
    // A degenerate random source falls back to an outward spiral of free cells.
    for (let ring = 1; !spot; ring++) for (let step = 0; step < ring * 8 && !spot; step++) {
      const angle = step / (ring * 8) * Math.PI * 2, x = Math.round(Math.cos(angle) * ring * width), y = Math.round(Math.sin(angle) * ring * height);
      if (free(x, y)) spot = {x, y};
    }
    placed.push(spot); result.set(id, spot);
  }
  if (positions.has(focus)) result.set(focus, {x: 0, y: 0});
  return result;
}
