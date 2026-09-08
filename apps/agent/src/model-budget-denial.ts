/** A daily allowance decision made by the trusted ledger before dispatch.
 * Shared by SQLite and Worker KV; no runtime-specific imports or other tenants'
 * usage counts. Provider errors and missing/corrupt ledgers are not this fact. */
export interface ModelBudgetDenial {
  version: 1;
  owner: string;
  day: string;
  scope: "account" | "global";
  limit: number;
}

export function isModelBudgetDenial(value: unknown): value is ModelBudgetDenial {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as ModelBudgetDenial;
  return Object.keys(v).sort().join(",") === "day,limit,owner,scope,version" &&
    v.version === 1 && typeof v.owner === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v.owner) &&
    typeof v.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.day) &&
    (v.scope === "account" || v.scope === "global") &&
    Number.isSafeInteger(v.limit) && v.limit >= 0;
}

export class ModelBudgetDenied extends Error {
  readonly denial: Readonly<ModelBudgetDenial>;
  constructor(denial: ModelBudgetDenial) {
    super("Daily inference allowance exhausted");
    if (!isModelBudgetDenial(denial)) throw Error("Invalid model allowance decision");
    this.name = "ModelBudgetDenied";
    this.denial = Object.freeze({ ...denial });
  }
}
