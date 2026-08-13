// Keyword-based severity classification for messages arriving from outside
// (webhook posts without an explicit level, and Telus/Alarm.com alert emails).

import type { EventLevel } from './types.js';

const ALARM_WORDS =
  /\b(alarm|intrusion|intruder|burglar|break[- ]?in|smoke|fire|carbon monoxide|co detected|glass ?break|panic|siren|tamper|emergency)\b/i;
const WARNING_WORDS =
  /\b(motion|opened|open(ed)?|closed?|unlock(ed)?|lock(ed)?|doorbell|person|people|vehicle|animal|detect(ed|ion)?|offline|low battery|left open)\b/i;

export function classifyLevel(message: string): EventLevel {
  if (ALARM_WORDS.test(message)) return 'alarm';
  if (WARNING_WORDS.test(message)) return 'warning';
  return 'info';
}
