import { useEffect, useState } from 'react';

// Stages the call-outcome route already decided. This module stores that
// string and lets the drawer, Pipeline, and Leads show it. It does not
// choose a stage.

const noted = new Map();
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

export function noteLeadStage(id, stage) {
  if (id == null || typeof stage !== 'string' || stage === '') return;
  const key = String(id);
  if (noted.get(key) === stage) return;
  noted.set(key, stage);
  emit();
}

// A later save for a lead we already updated from an outcome. Leads that
// were never noted stay on the payload their own view fetched.
export function replaceNotedStage(id, stage) {
  if (id == null || !noted.has(String(id))) return;
  noteLeadStage(id, stage);
}

export function notedStage(id) {
  if (id == null) return undefined;
  return noted.get(String(id));
}

export function withNotedStage(lead) {
  if (!lead || lead.id == null) return lead;
  const stage = noted.get(String(lead.id));
  if (stage == null || lead.stage === stage) return lead;
  return { ...lead, stage };
}

export function subscribeLeadStages(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLeadStageRevision() {
  const [, setRevision] = useState(0);
  useEffect(() => subscribeLeadStages(() => setRevision((value) => value + 1)), []);
}

export function resetNotedStages() {
  if (noted.size === 0) return;
  noted.clear();
  emit();
}
