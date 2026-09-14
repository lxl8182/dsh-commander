/**
 * Parse the bounded structured report that every DSH turn is asked to emit.
 *
 * Only a complete, well-formed block with correctly typed fields is accepted.
 * Anything else yields a fallback that is explicitly labelled as a fallback so
 * a missing or broken report can never be mistaken for a successful one.
 */
import { reportBeginMarker, reportEndMarker } from './contract.mjs';

export const finalTextLimit = 12000;
export const fallbackLimit = 2000;
export const reportPayloadLimit = 12000;

const clip = (value, limit) => String(value ?? '').slice(0, limit);
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function stringList(value, { limit = 200, itemLimit = 1000 } = {}) {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, value: [] };
  if (value.length > limit) return { ok: false, value: [] };
  const items = [];
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, value: [] };
    items.push(clip(item, itemLimit));
  }
  return { ok: true, value: items };
}

function checks(value) {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > 50) return { ok: false, value: [] };
  const items = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return { ok: false, value: [] };
    for (const key of ['command', 'status', 'evidence']) {
      if (entry[key] !== undefined && entry[key] !== null && typeof entry[key] !== 'string') return { ok: false, value: [] };
    }
    const status = entry.status === undefined || entry.status === null || entry.status === '' ? 'not_run' : entry.status;
    if (!['pass', 'fail', 'not_run'].includes(status)) return { ok: false, value: [] };
    items.push({ command: clip(entry.command, 1000), status, evidence: clip(entry.evidence ?? entry.details, 1000) });
  }
  return { ok: true, value: items };
}

function decision(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isPlainObject(value)) return { ok: false, value: null };
  if (value.question !== undefined && value.question !== null && typeof value.question !== 'string') return { ok: false, value: null };
  if (value.recommendation !== undefined && value.recommendation !== null && typeof value.recommendation !== 'string') return { ok: false, value: null };
  const options = stringList(value.options, { limit: 12, itemLimit: 1000 });
  if (!options.ok) return { ok: false, value: null };
  return { ok: true, value: { question: clip(value.question, 2000), options: options.value, recommendation: clip(value.recommendation, 2000) } };
}

export function clipFinalText(text) {
  const value = String(text ?? '');
  return value.length > finalTextLimit
    ? { text: value.slice(-finalTextLimit), truncated: true, fullLength: value.length }
    : { text: value, truncated: false, fullLength: value.length };
}

function extractBlock(text) {
  const start = text.lastIndexOf(reportBeginMarker);
  if (start < 0) return { kind: 'missing' };
  const bodyStart = start + reportBeginMarker.length;
  const end = text.indexOf(reportEndMarker, bodyStart);
  if (end < 0) {
    // A complete, earlier block followed by an opening marker means two
    // payloads were concatenated: ambiguous, never silently pick one.
    if (text.lastIndexOf(reportEndMarker, start - 1) >= 0) return { kind: 'ambiguous' };
    return { kind: 'truncated', payload: text.slice(bodyStart) };
  }
  const before = text.slice(0, start);
  const after = text.slice(end + reportEndMarker.length);
  // Exactly one report block is allowed; trailing prose is fine, a second block
  // is not.
  if (before.includes(reportBeginMarker) || after.includes(reportBeginMarker)) return { kind: 'ambiguous' };
  return { kind: 'block', payload: text.slice(bodyStart, end), before, after };
}

/** Parse one turn's raw output. Never throws. */
export function parseTurnReport(rawOutput) {
  const text = String(rawOutput ?? '');
  const block = extractBlock(text);
  if (block.kind === 'missing') return { report: null, reason: 'report_markers_missing' };
  if (block.kind === 'truncated') return { report: null, reason: 'report_truncated' };
  if (block.kind === 'ambiguous') return { report: null, reason: 'report_ambiguous_multiple_blocks' };
  if (block.payload.length>reportPayloadLimit) return { report:null,reason:'report_too_large' };
  let parsed;
  try {
    parsed = JSON.parse(block.payload);
  } catch {
    return { report: null, reason: 'report_json_invalid' };
  }
  if (!isPlainObject(parsed)) return { report: null, reason: 'report_not_an_object' };
  if (!['done', 'blocked', 'decision_required'].includes(parsed.outcome)) return { report: null, reason: 'report_outcome_invalid' };
  if (typeof parsed.summary !== 'string') return { report: null, reason: 'report_summary_invalid' };
  const changedFiles = stringList(parsed.changedFiles);
  if (!changedFiles.ok) return { report: null, reason: 'report_changedFiles_invalid' };
  const parsedChecks = checks(parsed.checks);
  if (!parsedChecks.ok) return { report: null, reason: 'report_checks_invalid' };
  const unresolved = stringList(parsed.unresolved);
  if (!unresolved.ok) return { report: null, reason: 'report_unresolved_invalid' };
  const parsedDecision = decision(parsed.decision);
  if (!parsedDecision.ok) return { report: null, reason: 'report_decision_invalid' };
  if (parsed.outcome==='decision_required'&&!parsedDecision.value?.question.trim()) return {report:null,reason:'report_decision_missing_question'};
  return {
    report: {
      outcome: parsed.outcome,
      summary: clip(parsed.summary, 4000),
      changedFiles: changedFiles.value,
      checks: parsedChecks.value,
      unresolved: unresolved.value,
      decision: parsedDecision.value,
      // Trailing prose after the end marker is redundant with `summary`; drop it.
      extraText: clip(block.after.trim(), 2000),
    },
    // Prose that preceded the block is not part of the report and is not
    // returned by compact view; it stays readable in the raw output artifact.
    preamble: clip(block.before.trim(), 2000),
    reason: null,
  };
}

/**
 * Text returned next to a parsed report. It is the bounded prose that preceded
 * the block, so compact responses never re-send the whole accumulated body.
 */
export function reportPreambleText(parsed) {
  const preamble = String(parsed?.preamble ?? '').trim();
  if (!preamble) return '';
  return preamble.length > 2000 ? preamble.slice(-2000) : preamble;
}

/**
 * Bounded tail excerpt used when no valid report block exists. The excerpt is
 * taken from the end because turn conclusions live there, and it is always
 * labelled as a fallback.
 */
export function fallbackExcerpt(rawOutput) {
  const text = String(rawOutput ?? '').trim();
  if (!text) return null;
  return text.length > fallbackLimit ? text.slice(-fallbackLimit) : text;
}
