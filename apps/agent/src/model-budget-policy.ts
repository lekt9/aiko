/** Runtime-independent limits shared by configuration and budget storage. */
export type ModelLimits = {
  globalPerDay: number;
  accountPerDay: number;
  maxConcurrent: number;
};

export const DEFAULT_MODEL_LIMITS: ModelLimits = {
  globalPerDay: 200,
  accountPerDay: 40,
  maxConcurrent: 4,
};
