/**
 * The server-owned pipeline version used for every newly-created UI run.
 *
 * Historical rows may still contain v1/v2 values.  Callers must never be able
 * to select a version for a new run.
 */
export const CURRENT_PIPELINE_VERSION = 3 as const;
