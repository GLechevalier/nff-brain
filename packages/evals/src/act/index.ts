// The act-benchmark registries. Layer A (deterministic engine conformance)
// and layer B (real-LLM agent capability), both scored through the shared
// scorecard and gated by the shared capabilities.json.

import type { ActAgentScenario, ActConformanceCase } from './actScenario.js';
import { pointerCases } from './cases/pointer.js';
import { dragCases } from './cases/drag.js';
import { scrollCases } from './cases/scroll.js';
import { keysCases } from './cases/keys.js';
import { editCases } from './cases/edit.js';
import { formsCases } from './cases/forms.js';
import { navCases } from './cases/nav.js';
import { tabsCases } from './cases/tabs.js';
import { dialogsCases } from './cases/dialogs.js';
import { mediaCases } from './cases/media.js';
import { contentCases } from './cases/content.js';
import { touchCases } from './cases/touch.js';
import { oosCases } from './cases/oos.js';
import { agentScenarios } from './agentScenarios.js';

export const ACT_CASES: ActConformanceCase[] = [
  ...pointerCases,
  ...dragCases,
  ...scrollCases,
  ...keysCases,
  ...editCases,
  ...formsCases,
  ...navCases,
  ...tabsCases,
  ...dialogsCases,
  ...mediaCases,
  ...contentCases,
  ...touchCases,
  ...oosCases,
];

export const ACT_AGENT_SCENARIOS: ActAgentScenario[] = agentScenarios;
