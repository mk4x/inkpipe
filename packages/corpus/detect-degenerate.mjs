// Moved to @inkpipe/quality so the corpus harness and the production agent run
// the identical detector. Kept as a re-export because the spike scripts and the
// ADR reference this path.
export { detectDegenerate } from '@inkpipe/quality';
