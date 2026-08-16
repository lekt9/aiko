const DIGEST = /^[0-9a-f]{64}$/;
const REFERENCE = /^[A-Za-z0-9._:/-]{1,256}$/;

export const SMITHERS_RETENTION_SCHEMA = "smithers.retention-projection/v1";

const PIN_SPECS = Object.freeze([
  ["contract_root", "contract", ["contractRootRef", "rootRef"], ["rootId"]],
  ["contract_occurrence", "contract", ["contractOccurrenceRef", "occurrenceRef"], ["occurrenceId"]],
  ["contract_execution", "contract", ["contractExecutionRef", "executionRef"], ["executionId", "operationId"]],
  ["contract_attempt_fence", "contract", ["contractAttemptFenceRef", "attemptFenceRef", "fenceRef"], ["attempt", "fence"]],
  ["cell_package", "contract", ["cellPackageRef", "packageRef"], ["cellPackageDigest"]],
  ["cell_manifest", "contract", ["cellManifestRef", "manifestRef"], ["cellManifestDigest"]],
  ["graph", "contract", ["graphRef"], ["graphDigest"]],
  ["input", "contract", ["inputRef"], ["inputDigest"]],
  ["source", "neuron", ["sourceRef"], ["sourceDigest"]],
  ["node", "contract", ["nodeRef"], ["nodeDigest"]],
  ["limb", "neuron", ["limbRef"], ["limbDigest"]],
  ["attachment", "neuron", ["attachmentRef"], ["attachmentGeneration"]],
  ["credential", "neuron", ["credentialRef"], ["credentialGeneration", "credentialScopeDigest"]],
  ["firing", "neuron", ["firingRef"], ["firingId"]],
  ["effect", "neuron", ["effectRef"], ["effectId"]],
  ["contract_journal_position", "contract", ["contractJournalRef", "contractJournalPosition"]],
  ["neuron_journal_position", "neuron", ["neuronJournalRef", "neuronJournalPosition"]],
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function areas(descriptor) {
  if (!descriptor || typeof descriptor !== "object") return [];
  return [descriptor, descriptor.retention, descriptor.refs, descriptor.pins].filter((item) => item && typeof item === "object");
}

function findRef(descriptors, aliases) {
  for (const descriptor of descriptors) {
    for (const area of areas(descriptor)) {
      for (const alias of aliases) if (area[alias] !== undefined) return area[alias];
    }
  }
  return undefined;
}

function expectedIdentity(descriptors, names = []) {
  const expected = {};
  for (const name of names) {
    for (const descriptor of descriptors) {
      if (descriptor?.[name] !== undefined) { expected[name] = descriptor[name]; break; }
    }
  }
  return expected;
}

function normalizePin(kind, authority, raw, expected = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`missing retention pin: ${kind}`);
  const reference = raw.reference ?? raw.ref;
  const commitOrdinal = raw.commitOrdinal ?? raw.commit_ordinal ?? raw.ordinal;
  const digest = raw.digest;
  if (typeof reference !== "string" || !REFERENCE.test(reference)) throw new Error(`invalid retention reference: ${kind}`);
  if (!Number.isSafeInteger(commitOrdinal) || commitOrdinal < 1) throw new Error(`invalid retention commit ordinal: ${kind}`);
  if (typeof digest !== "string" || !DIGEST.test(digest)) throw new Error(`invalid retention digest: ${kind}`);
  return { kind, authority, reference, commitOrdinal, digest, expected };
}

function resolveReader(reader, authority) {
  if (typeof reader === "function") return reader;
  for (const method of ["readRetentionPin", "readPin", "confirmRetentionPin"]) {
    if (typeof reader?.[method] === "function") return reader[method].bind(reader);
  }
  throw new TypeError(`${authority} retention reader is required`);
}

function normalizeConfirmation(pin, value) {
  if (!value || value.confirmed === false) return null;
  const record = value.pin && typeof value.pin === "object" ? value.pin : value;
  const reference = record.reference ?? record.ref;
  const commitOrdinal = record.commitOrdinal ?? record.commit_ordinal ?? record.ordinal;
  if (reference !== pin.reference || commitOrdinal !== pin.commitOrdinal || record.digest !== pin.digest) return null;
  for (const [name, expected] of Object.entries(pin.expected ?? {})) {
    if (record[name] !== expected && value[name] !== expected) return null;
  }
  const verdict = value.verdict ?? record.verdict ?? null;
  const state = value.state ?? record.state ?? null;
  const safeFact = (fact) => fact === null || (typeof fact === "string" && /^[a-z0-9_-]{1,64}$/.test(fact));
  if (!safeFact(verdict) || !safeFact(state)) return null;
  return { verdict, state };
}

function verdictIdentity(confirmations) {
  return canonical(confirmations.map(({ pin, confirmation }) => ({
    authority: pin.authority,
    kind: pin.kind,
    reference: pin.reference,
    commitOrdinal: pin.commitOrdinal,
    digest: pin.digest,
    verdict: confirmation.verdict,
    state: confirmation.state,
  })));
}

async function confirmPins(pins, readers) {
  const contractRead = resolveReader(readers.contractReader ?? readers.contract, "Contract");
  const neuronRead = resolveReader(readers.neuronReader ?? readers.neuron, "Neuron");
  const confirmed = [];
  const quarantine = [];
  for (const pin of pins) {
    const read = pin.authority === "contract" ? contractRead : neuronRead;
    const value = await read(Object.freeze({ ...pin }));
    const confirmation = normalizeConfirmation(pin, value);
    if (confirmation) confirmed.push({ pin, confirmation });
    else quarantine.push({ ...pin, reason: value ? "authority_mismatch" : "smithers_orphan" });
  }
  return { confirmed, quarantine };
}

/**
 * Project a Smithers run into authority-confirmed cross-journal pins.
 * Descriptors are hints only. A pin is authoritative only when the injected
 * Contract or Neuron reader returns the same reference, digest and ordinal.
 */
export async function projectContractRetention({
  driverDescriptor,
  recoveryDescriptor,
  runState = "active",
  contractReader,
  neuronReader,
  contract,
  neuron,
} = {}) {
  if (!driverDescriptor || !recoveryDescriptor) throw new TypeError("driverDescriptor and recoveryDescriptor are required");
  if (!new Set(["active", "settled", "archived"]).has(runState)) throw new Error("runState must be active, settled, or archived");

  const descriptors = [driverDescriptor, recoveryDescriptor];
  const candidates = PIN_SPECS.map(([kind, authority, aliases, identities]) => normalizePin(kind, authority, findRef(descriptors, aliases), expectedIdentity(descriptors, identities)));
  const duplicate = new Set();
  for (const pin of candidates) {
    const key = `${pin.authority}:${pin.reference}:${pin.commitOrdinal}:${pin.digest}`;
    if (duplicate.has(key)) throw new Error(`duplicate retention pin: ${pin.kind}`);
    duplicate.add(key);
  }

  const checked = await confirmPins(candidates, { contractReader, neuronReader, contract, neuron });
  const publicPin = ({ expected: _expected, ...pin }) => pin;
  const pins = checked.confirmed.map(({ pin }) => publicPin(pin));
  const quarantined = checked.quarantine.map((pin) => publicPin(pin));
  return deepFreeze({
    schema: SMITHERS_RETENTION_SCHEMA,
    runState,
    blocksLocalGc: runState === "active",
    complete: quarantined.length === 0,
    pins,
    quarantined,
    authoritativeVerdict: verdictIdentity(checked.confirmed),
  });
}

export const projectSmithersRetention = projectContractRetention;

export function requireLocalCollectible(projection) {
  if (projection?.schema !== SMITHERS_RETENTION_SCHEMA) throw new TypeError("invalid Smithers retention projection");
  if (projection.blocksLocalGc || projection.runState === "active") throw new Error("active Smithers run has live local references");
  if (!projection.complete || projection.quarantined.length) throw new Error("unconfirmed Smithers pins cannot authorize collection");
  return true;
}

/** Re-read authority before compacting and refuse any changed semantic verdict. */
export async function compactSettledProjection(projection, readers = {}) {
  requireLocalCollectible(projection);
  const checked = await confirmPins(projection.pins, readers);
  if (checked.quarantine.length) throw new Error("authority changed while compacting Smithers run");
  const after = verdictIdentity(checked.confirmed);
  if (after !== projection.authoritativeVerdict) throw new Error("authoritative Contract/Neuron verdict changed during local compaction");
  return deepFreeze({
    schema: projection.schema,
    runState: "archived",
    blocksLocalGc: false,
    complete: true,
    pins: projection.pins.map((pin) => ({ ...pin })),
    quarantined: [],
    authoritativeVerdict: after,
  });
}
