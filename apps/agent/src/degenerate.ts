// Single implementation, shared with the corpus harness so the gate the agent
// runs is byte-for-byte the gate the corpus measured. See packages/quality.
export { detectDegenerate } from '@inkpipe/quality';
export type { DegeneracyResult, DegeneracyOptions } from '@inkpipe/quality';
