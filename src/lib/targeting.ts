// ── Targeting configuration ───────────────────────────────────────────────────
// Single source of truth for the 2026-07 retarget: IC analytics/data, FP&A,
// and AEC-side IC roles. Replaces the prior GTM / AI Strategy / Founding PM
// targeting. This file changes scoring INPUTS only — the scoring engine
// architecture is unchanged.

export type Lane = 'analytics-data' | 'fpa' | 'aec-ic' | 'cj-vendor'

export const LANE_LABELS: Record<Lane, string> = {
  'analytics-data': 'Analytics/Data',
  'fpa':            'FP&A',
  'aec-ic':         'AEC-IC',
  'cj-vendor':      'CJ Vendor',   // exploratory — surfaced separately, never blended into primary lanes
}

// Relative lane priority: Analytics/Data > FP&A > AEC-IC. CJ vendor is
// exploratory and gets no priority boost — it is surfaced in its own section.
export const LANE_PRIORITY_BONUS: Record<Lane, number> = {
  'analytics-data': 6,
  'fpa':            4,
  'aec-ic':         2,
  'cj-vendor':      0,
}

export const LANE_TITLES: Record<Lane, string[]> = {
  'analytics-data': [
    'Senior Analytics Engineer',
    'BI Developer',
    'Senior Data Analyst',
    'Business Systems Analyst III',
    'Senior BI Engineer',
  ],
  'fpa': [
    'Senior Financial Analyst',
    'Senior FP&A Analyst',
    'Corporate Finance Analyst III',
    'Senior Financial Planning Analyst',
  ],
  // AEC-side IC: GC / owner / developer employers ONLY — AE firms and
  // consultancies are explicitly excluded from this lane.
  'aec-ic': [
    'Senior VDC Engineer',
    'Staff BIM Specialist',
    'Senior BIM Coordinator',
    'Senior Estimator',
    'Preconstruction Analyst',
  ],
  'cj-vendor': [],
}

// Old target categories — removed from active/forward-looking targeting
// (deliberate strategy change, 2026-07). Historical application data on these
// is preserved; they simply score as deprioritized going forward.
export const DEPRIORITIZED_ROLE_KEYWORDS = [
  'gtm', 'go-to-market',
  'ai strategy consultant',
  'ai implementation consultant',
  'founding pm', 'founding product manager',
  'solutions engineer',
  'customer success',
  'enablement',
]

// Titles containing these words are deprioritized regardless of the rest of
// the title.
export const DEPRIORITIZED_TITLE_WORDS = ['lead', 'head', 'enablement']

// ── Target company watchlist ─────────────────────────────────────────────────
// Openings at these companies are surfaced first, grouped by lane.

export const WATCHLIST: Record<Lane, string[]> = {
  'analytics-data': [
    'Procore',
    'Autodesk',                     // Construction Cloud
    'Document Crunch',
    'Billd',
    'Aurigo',
    'Built Technologies',
    'Trimble',
    'Dell',
    'Samsung Austin Semiconductor', // Taylor, TX
    'Texas Mutual Insurance',
    'Apple',                        // Austin
    'GM IT Innovation Center',      // Austin
    'Q2',
    'Indeed',
    'Charles Schwab',
    'CoStar',
    'ERCOT',                        // market/settlement analyst desk only — NOT control-room shift roles
  ],
  'fpa': [],       // FP&A lane shares the analytics/data company watchlist
  'aec-ic': [],    // AEC-IC lane targets GC/owner/developer employers found via search, not a fixed list
  // Criminal-justice vendor lane — tertiary/exploratory. Surfaced separately,
  // never blended into the main score.
  'cj-vendor': [
    'Tyler Technologies',
    'Axon',
    'LexisNexis Risk Solutions',
    'Recidiviz',
  ],
}

// ── Explicit exclusions ───────────────────────────────────────────────────────
// Never surface any opportunity at Clayton Korte, under any title.
// Never surface direct-employee conversion opportunities at Clayco.

export function isExcludedOpportunity(company: string, title = '', description = ''): string | null {
  const c = company.toLowerCase()
  const blob = `${title} ${description}`.toLowerCase()
  if (/\bclayton\s*korte\b/.test(c) || /\bclayton\s*korte\b/.test(blob)) {
    return 'Excluded: Clayton Korte — never surfaced'
  }
  // A posting BY Clayco is by definition a direct-employee opportunity.
  if (/\bclayco\b/.test(c)) {
    return 'Excluded: Clayco direct-employee conversion — never surfaced'
  }
  return null
}

// ── Red / green flag keyword scoring ─────────────────────────────────────────

export const RED_FLAG_KEYWORDS = [
  'stakeholder alignment',
  'cross-functional leadership',
  'player-coach',
  'wear many hats',
  'fast-paced',
  'influence without authority',
  'partner with stakeholders to translate goals',
  'partner with stakeholders to translate strategy',
  'anticipate and resolve issues before they escalate',
]

export const GREEN_FLAG_KEYWORDS = [
  'own the model',
  'own the dashboard',
  'backlog',
  'month-end close',
  'sql',
  'dbt',
  'power bi',
  'anaplan',
]

const RED_FLAG_PENALTY = 6    // per distinct red flag found
const RED_FLAG_CAP = 24
const GREEN_FLAG_BONUS = 4    // per distinct green flag found
const GREEN_FLAG_CAP = 16

function matchKeyword(text: string, keyword: string): boolean {
  // Word-boundary match so e.g. "sql" does not match "sqlite" mid-word noise;
  // multi-word phrases match as substrings with flexible whitespace.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text)
}

export function findRedFlags(text: string): string[] {
  return RED_FLAG_KEYWORDS.filter(k => matchKeyword(text, k))
}

export function findGreenFlags(text: string): string[] {
  return GREEN_FLAG_KEYWORDS.filter(k => matchKeyword(text, k))
}

// Deterministic post-LLM score adjustment. Applied on top of the model's
// rubric score so flag effects are reproducible and testable.
export function applyKeywordAdjustments(
  baseScore: number,
  title: string,
  description: string,
): { score: number; redFlags: string[]; greenFlags: string[] } {
  const text = `${title}\n${description}`
  const redFlags = findRedFlags(text)
  const greenFlags = findGreenFlags(text)
  const penalty = Math.min(redFlags.length * RED_FLAG_PENALTY, RED_FLAG_CAP)
  const bonus = Math.min(greenFlags.length * GREEN_FLAG_BONUS, GREEN_FLAG_CAP)
  const score = Math.max(0, Math.min(100, baseScore - penalty + bonus))
  return { score, redFlags, greenFlags }
}

// ── Lane assignment ───────────────────────────────────────────────────────────

const LANE_TITLE_PATTERNS: [Lane, RegExp][] = [
  ['aec-ic',         /\b(vdc|bim|estimator|preconstruction|precon)\b/i],
  ['fpa',            /\b(fp&a|fpa|financial analyst|finance analyst|financial planning|corporate finance)\b/i],
  ['analytics-data', /\b(analytics engineer|bi developer|bi engineer|data analyst|business systems analyst|business intelligence|analytics)\b/i],
]

export function laneForOpportunity(company: string, title: string): Lane | null {
  // CJ vendors always route to the separate exploratory lane, regardless of title.
  if (WATCHLIST['cj-vendor'].some(w => company.toLowerCase().includes(w.toLowerCase()))) {
    return 'cj-vendor'
  }
  for (const [lane, pattern] of LANE_TITLE_PATTERNS) {
    if (pattern.test(title)) return lane
  }
  return null
}

export function isWatchlistCompany(company: string): boolean {
  const c = company.toLowerCase()
  return Object.values(WATCHLIST).some(list =>
    list.some(w => c.includes(w.toLowerCase()))
  )
}

// Watchlist companies surface first: flat bonus + lane priority bonus.
export const WATCHLIST_BONUS = 5

export function watchlistAndLaneBonus(company: string, title: string): number {
  const lane = laneForOpportunity(company, title)
  const wl = isWatchlistCompany(company) ? WATCHLIST_BONUS : 0
  // CJ vendor lane gets NO bonus — kept out of the main-score blend.
  if (lane === 'cj-vendor') return 0
  return wl + (lane ? LANE_PRIORITY_BONUS[lane] : 0)
}

// ── Manual verification ───────────────────────────────────────────────────────
// Surfaced as a checklist item on shortlisted opportunities. Deliberately NOT
// inferred from title or posting text — "Manager" / "Senior Analyst" titles
// are unreliable signals in either direction.
export const SHORTLIST_SCORE_THRESHOLD = 75
export const MANUAL_CHECKLIST = ['Confirm zero direct reports']
