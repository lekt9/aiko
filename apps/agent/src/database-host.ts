import { StructuredStore, type Storage, type StoreOptions } from "../../../packages/structured-data/src/index.ts";
import { harnessBlobStore, type HarnessDigest } from "./harness-library.ts";
import type { WorkflowKV } from "./workflow-host.ts";
import type { DatabaseBinding } from "./database-component.ts";
import { databaseApprovals } from "./database-approvals.ts";

/** Adapt existing owner storage and private blob custody; this creates no execution loop. */
export function createDatabaseBinding(options: {
  owner: string;
  thread: string;
  storage: Storage;
  kv: WorkflowKV;
  authorize: DatabaseBinding["authorize"];
  storeOptions?: StoreOptions;
  readEvents?: DatabaseBinding["readEvents"];
  sources?: DatabaseBinding["sources"];
}): DatabaseBinding {
  const blobs = harnessBlobStore(options.kv);
  const approvals = databaseApprovals(options.owner, options.thread, options.storeOptions?.now);
  const domains = new Map(options.storeOptions?.domains);
  domains.set(approvals.collection.definition.id, approvals.collection);
  return {
    owner: options.owner,
    thread: options.thread,
    store: new StructuredStore(options.storage, options.owner, { ...options.storeOptions, domains }),
    readEvents: options.readEvents,
    sources: options.sources,
    collections: approvals.update,
    authorize: options.authorize,
    custody: {
      put: (owner, value) => blobs.putPrivate(owner, value),
      get: (owner, ref) => {
        if (!/^sha256:[a-f0-9]{64}$/.test(ref)) throw Error("Invalid private database reference");
        return blobs.get(owner, ref as HarnessDigest);
      },
    },
  };
}
