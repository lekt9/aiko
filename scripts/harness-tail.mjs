/** Seek the tail of an append-only, ascending event journal in O(log(head))
 * requests, then keep a cursor. Never mistake the first page for recent work.
 * readPage(after, limit) must throw on an HTTP/protocol error.
 */
export async function eventTail(readPage, previous) {
  let probes = 0;
  const read = async (after, limit = 100) => {
    if (++probes > 64)
      throw new Error("journal tail seek exceeded its probe budget");
    const page = await readPage(after, limit);
    if (
      !Array.isArray(page.events) ||
      typeof page.hasMore !== "boolean" ||
      !Number.isSafeInteger(page.nextAfter) ||
      page.nextAfter < after ||
      page.events.some(
        (r, i) =>
          !Number.isSafeInteger(r.seq) ||
          r.seq <= (i ? page.events[i - 1].seq : after),
      ) ||
      (page.events.length && page.nextAfter !== page.events.at(-1).seq) ||
      (!page.events.length && page.hasMore)
    )
      throw new Error("invalid journal page");
    return page;
  };
  const first = await read(previous?.head ?? 0);
  if (!first.hasMore) {
    return {
      head: first.nextAfter,
      rows: [...(previous?.rows ?? []), ...first.events].slice(-3),
    };
  }
  let lower = first.nextAfter,
    upper,
    step = 100;
  while (upper === undefined) {
    const after = lower + step;
    if (!Number.isSafeInteger(after)) throw new Error("invalid journal cursor");
    const page = await read(after);
    if (!page.events.length) upper = after;
    else {
      lower = page.nextAfter;
      if (!page.hasMore) break;
      step *= 2;
    }
  }
  while (upper !== undefined && upper - lower > 1) {
    const page = await read(Math.floor((lower + upper) / 2));
    if (!page.events.length) upper = Math.floor((lower + upper) / 2);
    else {
      lower = page.nextAfter;
      if (!page.hasMore) break;
    }
  }
  // The SQL journal has contiguous sequences. Reading again at the located
  // head also handles a tail page containing fewer than three rows.
  const final = await read(lower);
  const tail = await read(Math.max(0, final.nextAfter - 3), 3);
  return { head: tail.nextAfter, rows: tail.events };
}
