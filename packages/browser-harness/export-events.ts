import { makeActorClient, type EventRow } from "tardie/client"
import { canonicalStringify, sha256 } from "./src/har"

interface Options {
  readonly thread: string
  readonly baseUrl: string
  readonly actor: string
  readonly pageSize: number
}

export interface EventLogExport {
  readonly formatVersion: 1
  readonly actor: string
  readonly thread: string
  readonly rowCount: number
  readonly lastSeq: number
  readonly digest: string
  readonly rows: ReadonlyArray<EventRow>
}

const usage = `Usage:
  bun run export-events.ts <thread> [options]

Options:
  --url <url>          Tardigrade server (default: http://localhost:4242)
  --actor <instance>   Actor instance (default: main)
  --page-size <count>  Rows requested per page, 1-1000 (default: 200)
  --help               Show this help

Authentication is read only from TARDIGRADE_TOKEN.`

const requiredValue = (args: ReadonlyArray<string>, index: number, flag: string): string => {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

export const parseExportArgs = (args: ReadonlyArray<string>): Options => {
  let thread: string | undefined
  let baseUrl = "http://localhost:4242"
  let actor = "main"
  let pageSize = 200
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--help" || arg === "-h") throw new Error(usage)
    if (arg === "--url") {
      baseUrl = requiredValue(args, index, arg)
      index++
      continue
    }
    if (arg === "--actor") {
      actor = requiredValue(args, index, arg)
      index++
      continue
    }
    if (arg === "--page-size") {
      const raw = requiredValue(args, index, arg)
      pageSize = Number(raw)
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
        throw new Error("--page-size must be an integer from 1 to 1000")
      }
      index++
      continue
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`)
    if (thread !== undefined) throw new Error("Only one thread may be exported at a time")
    thread = arg
  }
  if (thread === undefined) throw new Error(usage)
  return { thread, baseUrl: baseUrl.replace(/\/+$/u, ""), actor, pageSize }
}

export const drainEventRows = async (
  readPage: (after: number, limit: number) => Promise<ReadonlyArray<EventRow>>,
  pageSize: number,
  options: { readonly requireContiguous?: boolean } = {}
): Promise<ReadonlyArray<EventRow>> => {
  const rows: EventRow[] = []
  let after = 0
  const requireContiguous = options.requireContiguous ?? true
  while (true) {
    const page = await readPage(after, pageSize)
    if (page.length === 0) return rows
    for (const row of page) {
      if (!Number.isSafeInteger(row.seq) || row.seq <= after || (requireContiguous && row.seq !== after + 1)) {
        throw new Error(`event sequence did not advance correctly after ${after}; received ${String(row.seq)}`)
      }
      rows.push(row)
      after = row.seq
    }
  }
}

export const exportEventLog = async (options: Options): Promise<EventLogExport> => {
  const token = process.env.TARDIGRADE_TOKEN?.trim()
  const client = makeActorClient({
    baseUrl: options.baseUrl,
    ...(token === undefined || token.length === 0 ? {} : { token })
  })
  const rows = await drainEventRows(
    (after, limit) => client.events(options.actor, options.thread, { after, limit }),
    options.pageSize
  )
  return {
    formatVersion: 1,
    actor: options.actor,
    thread: options.thread,
    rowCount: rows.length,
    lastSeq: rows.at(-1)?.seq ?? 0,
    digest: `sha256:${sha256(canonicalStringify(rows))}`,
    rows
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage)
  } else {
    try {
      console.log(JSON.stringify(await exportEventLog(parseExportArgs(args)), null, 2))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
