import { resolve } from "node:path"
import { makeActorClient, ProblemError } from "tardie/client"
import { drainEventRows } from "./export-events"
import { MAX_HAR_FILE_BYTES, HarImportInputError, prepareHarImportBytes, type Options, type HarImportBytesOptions, type HarImportResult } from "./src/trusted-network"
export * from "./src/trusted-network"

const usage = `Usage:
  bun run import-har.ts <capture.har> [options]

Options:
  --url <url>         Tardigrade server (default: http://localhost:4242)
  --actor <instance>  Actor instance (default: main)
  --capture <id>      Stable capture ID (default: digest-derived)
  --thread <id>       Destination thread (default: capture ID)
  --include-paths     Retain low-risk route-name segments; review dry-run first
  --include-metadata  Retain redacted page title and description; review first
  --dry-run           Print the redacted event JSONL without sending it
  --help              Show this help

Authentication is read only from TARDIGRADE_TOKEN.`

const requiredValue = (args: ReadonlyArray<string>, index: number, flag: string): string => {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

export const parseArgs = (args: ReadonlyArray<string>): Options => {
  let file: string | undefined
  let baseUrl = "http://localhost:4242"
  let actor = "main"
  let captureId: string | undefined
  let thread: string | undefined
  let dryRun = false
  let includePathSegments = false
  let includePageMetadata = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--help" || arg === "-h") throw new Error(usage)
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg === "--include-paths") {
      includePathSegments = true
      continue
    }
    if (arg === "--include-metadata") {
      includePageMetadata = true
      continue
    }
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
    if (arg === "--capture") {
      captureId = requiredValue(args, index, arg)
      index++
      continue
    }
    if (arg === "--thread") {
      thread = requiredValue(args, index, arg)
      index++
      continue
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`)
    if (file !== undefined) throw new Error("Only one HAR file may be imported at a time")
    file = arg
  }
  if (file === undefined) throw new Error(usage)
  return {
    file,
    baseUrl: baseUrl.replace(/\/+$/u, ""),
    actor,
    ...(captureId === undefined ? {} : { captureId }),
    ...(thread === undefined ? {} : { thread }),
    dryRun,
    includePathSegments,
    includePageMetadata
  }
}

export const assertCompatibleDestination = (
  events: ReadonlyArray<{ readonly type: string; readonly [key: string]: unknown }>,
  captureId: string,
  thread: string,
  importDigest: string
): void => {
  const declarations = events.filter((event) => event.type === "HarCaptureDeclared")
  if (declarations.some((event) => event.captureId !== captureId)) {
    throw new Error(`thread ${JSON.stringify(thread)} already belongs to another capture; use one thread per capture`)
  }
  const declared = declarations.find((event) => event.captureId === captureId)
  if (declared !== undefined && declared.importDigest !== importDigest) {
    throw new Error(
      `capture ${JSON.stringify(captureId)} already exists in thread ${JSON.stringify(thread)} with a different import digest`
    )
  }
}

export const runImportBytes = async (
  bytes: Uint8Array,
  options: HarImportBytesOptions
): Promise<HarImportResult> => {
  const prepared = prepareHarImportBytes(bytes, options)
  const { captureId, thread, importDigest, events } = prepared
  if (options.expectedImportDigest !== undefined && options.expectedImportDigest !== importDigest) {
    throw new HarImportInputError("HAR payload changed after its structural preview")
  }

  if (options.dryRun) {
    events.forEach((event) => console.log(JSON.stringify(event)))
  } else {
    const token = options.token?.trim() || process.env.TARDIGRADE_TOKEN?.trim()
    const client = makeActorClient({
      baseUrl: options.baseUrl,
      ...(token === undefined || token.length === 0 ? {} : { token })
    })
    try {
      const existing = await drainEventRows(
        (after, limit) => client.events(options.actor, thread, {
          after,
          limit,
          types: ["HarCaptureDeclared"]
        }),
        200,
        { requireContiguous: false }
      )
      assertCompatibleDestination(existing.map((row) => row.event), captureId, thread, importDigest)
    } catch (error) {
      if (!(error instanceof ProblemError && (error.title === "Unknown Thread" || error.title === "Unknown Actor"))) throw error
    }
    for (const event of events) await client.append(options.actor, thread, event)
  }

  return {
    captureId,
    thread,
    attemptedEvents: events.length,
    importDigest,
    dryRun: options.dryRun
  }
}

export const runImport = async (options: Options): Promise<HarImportResult> => {
  const path = resolve(options.file)
  const file = Bun.file(path)
  if (file.size > MAX_HAR_FILE_BYTES) {
    throw new Error(`HAR file is ${file.size} bytes; the limit is ${MAX_HAR_FILE_BYTES} bytes`)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  return runImportBytes(bytes, {
    baseUrl: options.baseUrl,
    actor: options.actor,
    ...(options.captureId === undefined ? {} : { captureId: options.captureId }),
    ...(options.thread === undefined ? {} : { thread: options.thread }),
    dryRun: options.dryRun,
    includePathSegments: options.includePathSegments,
    includePageMetadata: options.includePageMetadata
  })
}

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage)
  } else {
    try {
      const result = await runImport(parseArgs(args))
      console.error(JSON.stringify(result))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
