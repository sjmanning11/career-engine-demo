// ── Location gate — single source of truth ───────────────────────────────────
// Deterministic relocation signal computed in code, injected into scoring
// prompts. This exists because some sources (notably Adzuna) geocode fully
// remote jobs to a physical city and truncate descriptions, so "location says
// a non-Austin city and the snippet doesn't mention remote" is NOT a reliable
// on-site signal. Only explicit language may trigger the relocation exclusion.
//
// Every scoring code path (cron, generate-live) must import the precheck and
// the prompt block from here — do not copy the gate text into route files,
// where it can drift out of sync (that drift is exactly what caused the
// original hard-score-0 bug in generate-live).

export type LocationPrecheck =
  | 'REMOTE_ELIGIBLE'
  | 'AUSTIN_METRO'
  | 'EXPLICIT_ONSITE_NON_AUSTIN'
  | 'UNCLEAR'

const REMOTE_LOCATION_RE = /\b(remote|anywhere|distributed|worldwide|global|telecommute)\b/i
const AUSTIN_METRO_RE = /\b(austin|georgetown|round rock|cedar park|leander|pflugerville|hutto|taylor|buda|kyle|san marcos)\b/i
const EXPLICIT_ONSITE_RE = /\b(relocation\s+(?:is\s+)?required|must\s+relocate|willing\s+to\s+relocate|on-?site\s+(?:only|required)|in-?office\s+(?:only|required)|no\s+remote)\b/i
const REMOTE_DESC_RE = /\b(remote|work[- ]from[- ]home|work[- ]from[- ]anywhere|wfh|telecommute|fully distributed)\b/i

export function locationPrecheck(location: string, description: string): LocationPrecheck {
  // Structured location field is the most reliable signal — check it first.
  if (REMOTE_LOCATION_RE.test(location)) return 'REMOTE_ELIGIBLE'
  if (AUSTIN_METRO_RE.test(location)) return 'AUSTIN_METRO'
  // Explicit on-site language beats an incidental "remote" mention
  // (e.g. "no remote" must not read as remote-eligible).
  if (EXPLICIT_ONSITE_RE.test(description)) return 'EXPLICIT_ONSITE_NON_AUSTIN'
  if (REMOTE_DESC_RE.test(description)) return 'REMOTE_ELIGIBLE'
  return 'UNCLEAR'
}

// Step-1 instruction text shared by every scoring prompt. Call sites whose
// output schema differs from the plain {"score","label","summary"} shape
// (e.g. generate-live's roleFit object) must append a short adaptation note
// mapping the exclusion output to their schema — but must NOT reword the gate
// rules themselves.
export const LOCATION_GATE_PROMPT_BLOCK = `STEP 1 — LOCATION GATE (evaluate before anything else):
Each job includes a LOCATION PRE-CHECK line computed deterministically in code from the source's structured location fields and explicit posting language. It is authoritative — apply it exactly as follows:
- REMOTE_ELIGIBLE or AUSTIN_METRO: the location gate is PASSED. Do NOT exclude this role for relocation under any circumstances. Proceed to Step 2. This overrides any location-gate instruction elsewhere in your instructions.
- EXPLICIT_ONSITE_NON_AUSTIN: output {"score": 0, "label": "Excluded - relocation required", "summary": "Role requires relocation outside Austin TX commute area. Hard filter applied."} and stop immediately.
- UNCLEAR: exclude ONLY if the DESCRIPTION text explicitly states the role is on-site or hybrid at a specific location outside the Austin TX metro (35-mile commute radius from Georgetown TX 78626) with no remote option. A location field naming a city is NOT sufficient by itself — job boards geocode remote roles to cities, and descriptions may be truncated. If the description is silent or ambiguous about work arrangement, do NOT exclude: proceed to Step 2 and score Remote/location as Tier 3 (6 pts), flagging the summary with "[Manual review: location policy unclear]".`
