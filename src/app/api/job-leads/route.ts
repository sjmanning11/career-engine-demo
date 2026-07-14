import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getDb, initDb } from '@/lib/db'
import { DNA_PROMPT } from '@/lib/dna'
import { scrapeAllTargets, type JobLead } from '@/lib/jobLeadsScraper'
import { isExcludedOpportunity, applyKeywordAdjustments, watchlistAndLaneBonus, laneForOpportunity } from '@/lib/targeting'

export const maxDuration = 300

// ── Scoring ───────────────────────────────────────────────────────────────────

const CURATED_SCORING_PROMPT = `You are scoring a job posting for Sam Manning.

STEP 1 — LOCATION GATE:
Is this role on-site AND located outside the Austin, TX metro area AND does it not
explicitly state remote work is available?
If YES to all three: output {"score": 0, "label": "Excluded - relocation required",
"summary": "Role requires relocation outside Austin TX. Hard filter applied."} and stop.

STEP 2 — Hard exclusions: Clayton Korte (any title) or a Clayco direct-employee
conversion: output {"score": 0, "label": "Disqualified", "summary": "Excluded
company. Hard filter applied."} and stop.

STEP 3 — Score 0-100 using this rubric:
- Role type fit (30 pts): Lane 1 Analytics/Data IC (Analytics Engineer, BI Developer/Engineer, Senior Data Analyst, Business Systems Analyst) = 25-30. Lane 2 FP&A IC (Senior Financial/FP&A/Corporate Finance Analyst) = 20-27. Lane 3 AEC-side IC at GC/owner/developer only (VDC, BIM, Estimator, Preconstruction) = 15-22, but 0-4 at AE firms or consultancies. Adjacent IC analytics/finance = 5-14. Deprioritized (GTM, AI Strategy/Implementation Consultant, Founding PM, Solutions Engineer, Customer Success, Lead/Head/Enablement titles), AE/BD/SWE, people manager = 0-4.
- Company stage & size (20 pts): Target-watchlist company or mature data/finance/VDC org with clear IC role = 17-20. Established credible company = 12-16. Early-stage or unclear = 6-11. Pre-product, AE firm, or consultancy = 0-5.
- Remote/location (15 pts): Fully remote = 15. Austin hybrid within 35 miles of Georgetown TX = 12. Austin unclear policy = 6. Relocation or 5-day in-office = 0.
- Compensation signal (15 pts): $180K+ stated = 13-15. $150-180K = 9-12. $120-150K with equity = 4-8. Below $120K = 0-3.
- Build ownership (10 pts): Owns building from zero = 9-10. Significant build component = 6-8. Some tooling = 3-5. Advisory/management only = 0-2.
- Team caliber (5 pts): YC/tier-1/technical founders = 5. Experienced with traction = 3-4. Unknown founders = 1-2. Red flags = 0.

Return ONLY a JSON object, no markdown, no preamble:
{"score": <integer 0-100>, "label": "<Poor match|Partial match|Good match|Strong match|Exceptional match|Excluded - relocation required>", "summary": "<one sentence>"}`

async function scoreJob(
  client: Anthropic,
  title: string,
  company: string,
  location: string,
  description: string,
): Promise<{ score: number; label: string; summary: string } | null> {
  // Hard exclusions — never surface, never score.
  if (isExcludedOpportunity(company, title, description)) return null

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: DNA_PROMPT,
      messages: [{
        role: 'user',
        content: `${CURATED_SCORING_PROMPT}

JOB TITLE: ${title}
COMPANY: ${company}
LOCATION: ${location}
DESCRIPTION: ${description.slice(0, 2_000)}`,
      }],
    })
    const content = msg.content[0]
    if (content.type !== 'text') return null
    const raw = content.text.trim()
    const start = raw.indexOf('{')
    const end   = raw.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    const baseScore = typeof parsed.score === 'number' ? parsed.score : 0
    const label     = typeof parsed.label === 'string' ? parsed.label : 'Unknown'
    let summary     = typeof parsed.summary === 'string' ? parsed.summary : ''

    if (baseScore === 0) return { score: 0, label, summary }

    // Deterministic post-LLM adjustments: red/green flag keywords, then
    // watchlist + lane priority bonus (CJ vendor lane gets no bonus).
    const adjusted = applyKeywordAdjustments(baseScore, title, description)
    const score = Math.min(100, adjusted.score + watchlistAndLaneBonus(company, title))
    if (adjusted.redFlags.length > 0)   summary += ` [Red flags: ${adjusted.redFlags.join('; ')}]`
    if (adjusted.greenFlags.length > 0) summary += ` [Green flags: ${adjusted.greenFlags.join('; ')}]`

    return { score, label, summary }
  } catch {
    return null
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertLead(sql: ReturnType<typeof import('@/lib/db')['getDb']>, lead: JobLead, scored: { score: number; label: string; summary: string } | null) {
  await sql`
    INSERT INTO job_leads (
      external_id, title, company, location,
      salary_min, salary_max, salary_display,
      description, url, source, status, date_found,
      fit_score, fit_label, fit_summary,
      location_unverified, requires_manual_review, lane
    ) VALUES (
      ${lead.externalId}, ${lead.title}, ${lead.company}, ${lead.location},
      ${null}, ${null}, ${null},
      ${lead.description || null}, ${lead.applyUrl}, ${lead.source}, 'new', NOW(),
      ${scored?.score ?? null}, ${scored?.label ?? null}, ${scored?.summary ?? null},
      ${lead.locationUnverified}, ${lead.requiresManualReview},
      ${lead.lane ?? laneForOpportunity(lead.company, lead.title)}
    )
    ON CONFLICT (external_id) DO UPDATE SET
      title                 = EXCLUDED.title,
      location              = EXCLUDED.location,
      description           = EXCLUDED.description,
      date_found            = EXCLUDED.date_found,
      fit_score             = COALESCE(EXCLUDED.fit_score, job_leads.fit_score),
      fit_label             = COALESCE(EXCLUDED.fit_label, job_leads.fit_label),
      fit_summary           = COALESCE(EXCLUDED.fit_summary, job_leads.fit_summary),
      location_unverified   = EXCLUDED.location_unverified,
      requires_manual_review = EXCLUDED.requires_manual_review,
      lane                  = EXCLUDED.lane
  `
}

// ── Shared refresh logic ──────────────────────────────────────────────────────

async function runRefresh(isCron = false): Promise<Response> {
  await initDb()
  const sql    = getDb()
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const { leads, errors } = await scrapeAllTargets()
  let scored  = 0
  let stored  = 0
  let skipped = 0
  let claudeCallsThisRun = 0
  const MAX_CLAUDE_CALLS = 10

  for (const lead of leads) {
    // Hard exclusions — never store or surface these opportunities at all.
    if (isExcludedOpportunity(lead.company, lead.title, lead.description)) {
      skipped++
      continue
    }

    const existing = await sql`
      SELECT id FROM job_leads WHERE external_id = ${lead.externalId}
    `
    if (existing.length > 0) {
      skipped++
      try { await upsertLead(sql, lead, null) } catch {}
      continue
    }

    const isPlaceholder = lead.title === 'Check careers page manually' ||
                          lead.title.startsWith('Check via') ||
                          lead.title.startsWith('Scrape failed')

    let scoreResult = null
    if (!isPlaceholder && process.env.ANTHROPIC_API_KEY && claudeCallsThisRun < MAX_CLAUDE_CALLS) {
      scoreResult = await scoreJob(client, lead.title, lead.company, lead.location, lead.description)
      if (scoreResult) { scored++; claudeCallsThisRun++ }
    } else {
      skipped++
    }

    try {
      await upsertLead(sql, lead, scoreResult)
      stored++
    } catch (err) {
      errors.push(`DB upsert failed for ${lead.externalId}: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (scoreResult) await new Promise(r => setTimeout(r, 300))
  }

  return Response.json({
    success: true,
    cron: isCron,
    scraped: leads.length,
    scored,
    stored,
    skipped,
    errors,
  })
}

// ── GET — return stored curated leads, or trigger cron scrape ─────────────────

export async function GET(request: NextRequest) {
  // Vercel cron authentication
  const authHeader = request.headers.get('authorization')
  if (authHeader === `Bearer ${process.env.CRON_SECRET}`) {
    return runRefresh(true)
  }

  // Manual view — requires LIVE_MODE_TOKEN
  const token = request.headers.get('X-Live-Token')
  if (token !== process.env.LIVE_MODE_TOKEN) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await initDb()
  const sql = getDb()

  const leads = await sql`
    SELECT
      id, external_id, title, company, location,
      url, fit_score, fit_label, fit_summary,
      date_found, status, source, description,
      location_unverified, requires_manual_review, lane
    FROM job_leads
    WHERE (source = 'target-ashby'
        OR source = 'target-greenhouse'
        OR source = 'target-custom')
      AND fit_score >= 50
      AND company !~* '\\yclayton\\s*korte\\y'
      AND company !~* '\\yclayco\\y'
    ORDER BY
      fit_score DESC NULLS LAST,
      date_found DESC
    LIMIT 200
  `

  return Response.json({ leads })
}

// ── POST — manual refresh triggered from the UI ───────────────────────────────

export async function POST(request: NextRequest) {
  const token = request.headers.get('X-Live-Token')
  if (token !== process.env.LIVE_MODE_TOKEN) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)

  if (url.searchParams.get('action') === 'score-pending') {
    await initDb()
    const sql = getDb()
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const unscored = await sql`
      SELECT * FROM job_leads
      WHERE fit_score IS NULL
        AND title NOT LIKE 'Check%'
        AND title NOT LIKE 'Scrape%'
      ORDER BY date_found DESC
      LIMIT 10
    `

    let scored = 0
    for (const lead of unscored) {
      const scoreResult = await scoreJob(
        client, lead.title, lead.company, lead.location, lead.description ?? ''
      )
      if (scoreResult) {
        await sql`
          UPDATE job_leads
          SET fit_score   = ${scoreResult.score},
              fit_label   = ${scoreResult.label},
              fit_summary = ${scoreResult.summary}
          WHERE id = ${lead.id}
        `
        scored++
      }
      await new Promise(r => setTimeout(r, 300))
    }

    return Response.json({ success: true, scored, remaining: unscored.length - scored })
  }

  try {
    const body = await request.json() as { refresh?: boolean }
    if (!body.refresh) {
      return Response.json({ error: 'Pass { refresh: true } to trigger a scrape' }, { status: 400 })
    }
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  try {
    return await runRefresh(false)
  } catch (error) {
    console.error('job-leads refresh error:', error)
    return Response.json(
      { error: 'Refresh failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
