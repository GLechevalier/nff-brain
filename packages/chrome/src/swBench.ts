// BENCH ENTRY POINT — built as dist/sw.js ONLY when NFF_BRAIN_BENCH=1
// (build.mjs swaps the sw entry to this file). The production worker plus the
// act-benchmark driver. Import order matters and both imports are synchronous,
// so every listener — sw.ts's and benchDriver.ts's — registers before the
// first await, per the MV3 rule sw.ts documents.
//
// Never shipped: zip.mjs refuses a dist/sw.js containing the bench sentinel.

import './sw.js';
import './benchDriver.js';
