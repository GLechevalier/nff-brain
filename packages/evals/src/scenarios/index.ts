// The scenario registry — every use-case ladder level, registered from day
// one. test/scenarioRegistry.test.ts pins id uniqueness and shape.

import type { AnyScenario } from '../scenario.js';
import { calendarConflictsL1, calendarFocusBlocksL2 } from './calendar.js';
import { crmReconcileInboxL4, crmStalledL1 } from './crm.js';
import { emailInvoicesToDriveL5, emailLabelL2, emailSummarizeL1 } from './email.js';
import { linkedinConnectL1, linkedinExportL1 } from './linkedin.js';
import { recruitingSummarizeL1 } from './recruiting.js';
import { slackSummarizeL1 } from './slack.js';

export const SCENARIOS: AnyScenario[] = [
  // linkedin
  linkedinConnectL1,
  linkedinExportL1,
  // email
  emailSummarizeL1,
  emailLabelL2,
  emailInvoicesToDriveL5,
  // calendar
  calendarConflictsL1,
  calendarFocusBlocksL2,
  // slack
  slackSummarizeL1,
  // crm
  crmStalledL1,
  crmReconcileInboxL4,
  // recruiting
  recruitingSummarizeL1,
];

export function scenarioById(id: string): AnyScenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
