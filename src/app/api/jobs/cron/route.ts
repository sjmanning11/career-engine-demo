import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getDb, initDb } from '@/lib/db'
import { DNA_PROMPT } from '@/lib/dna'
import {
  LANE_TITLES,
  WATCHLIST,
  isExcludedOpportunity,
  applyKeywordAdjustments,
  watchlistAndLaneBonus,
  laneForOpportunity,
} from '@/lib/targeting'
import { isAustinOrRemote } from '@/lib/jobLeadsScraper'
import { locationPrecheck, LOCATION_GATE_PROMPT_BLOCK } from '@/lib/locationGate'

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID!
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY!

// Search titles are driven by the three active lanes (Analytics/Data > FP&A > AEC-IC).
const SEARCH_TITLES = [
  ...LANE_TITLES['analytics-data'],
  ...LANE_TITLES['fpa'],
  ...LANE_TITLES['aec-ic'],
]

// ATS board slugs — seed list. The prior GTM-era seed companies were removed
// as part of the 2026-07 retarget. Watchlist companies are probed and verified
// dynamically by discoverAndVerifyATSCompanies(); confirmed slugs live in the
// ats_companies table.
const TARGET_COMPANIES: { slug: string; name: string; ats: 'ashby' | 'lever' | 'greenhouse' }[] = []

export const maxDuration = 300

// ── Shared types ─────────────────────────────────────────────────────────────

type Results = {
  fetched: number
  scored: number
  saved: number
  errors: string[]
  bySource: Record<string, { fetched: number; saved: number }>
}

// ── Shared scoring helper ─────────────────────────────────────────────────────
// Location pre-check + Step-1 gate text live in @/lib/locationGate — the
// single source of truth shared with generate-live.

const SCORING_PROMPT = `You are scoring a job posting for Sam Manning.

${LOCATION_GATE_PROMPT_BLOCK}

STEP 2 — Only if the role passed Step 1, check hard exclusions:
Clayton Korte (any title) or a Clayco direct-employee conversion: output {"score": 0, "label": "Disqualified", "summary": "Excluded company. Hard filter applied."} and stop.

STEP 3 — Only if the role passed Steps 1-2, score it 0–100 using this rubric:
- Role type fit (30 pts max): Lane 1 Analytics/Data IC (Analytics Engineer, BI Developer/Engineer, Senior Data Analyst, Business Systems Analyst) = 25-30. Lane 2 FP&A IC (Senior Financial/FP&A/Corporate Finance Analyst) = 20-27. Lane 3 AEC-side IC at GC/owner/developer only (VDC, BIM, Estimator, Preconstruction) = 15-22, but 0-4 at AE firms or consultancies. Adjacent IC analytics/finance = 5-14. Deprioritized (GTM, AI Strategy/Implementation Consultant, Founding PM, Solutions Engineer, Customer Success, Lead/Head/Enablement titles), AE/BD/SWE, people manager = 0-4.
- Company stage & size (20 pts max): Target-watchlist company or mature data/finance/VDC org with clear IC role = 17-20. Established credible company = 12-16. Early-stage or unclear = 6-11. Pre-product, AE firm, or consultancy = 0-5.
- Remote/location (15 pts max):
    TIER 1 — 15 pts: Fully remote, no office requirement.
    TIER 2 — 12 pts: Austin-based or hybrid within 35 miles of Georgetown TX (78626). Cities in range: Austin, Round Rock, Cedar Park, Leander, Georgetown, Pflugerville, Hutto, Taylor, Buda, Kyle, San Marcos. Role must be hybrid or flexible — not 5 days/week in office.
    TIER 3 — 6 pts: Role with unclear or unstated remote/hybrid policy (including any role that reached this step with LOCATION PRE-CHECK: UNCLEAR). Flag summary with "[Manual review: location policy unclear]". Do NOT score 0 for ambiguity — default to 6.
    TIER 4 — 0 pts: Requires relocation outside the Austin metro, OR mandates 5-day in-office attendance regardless of location.
- Compensation signal (15 pts max): $180K+ stated = 13-15. $150-180K = 9-12. $120-150K with equity = 4-8. Below $120K = 0-3.
- Build ownership (10 pts max): Owns building from zero = 9-10. Significant build component = 6-8. Some tooling work = 3-5. Advisory/management only = 0-2.
- Adoption authority (5 pts max): Authority over implementation = 5. Reasonable cross-functional influence = 3-4. Hands off to others = 1-2. No adoption ownership = 0.
- Team caliber (5 pts max): YC/tier-1/technical founders = 5. Experienced founders with traction = 3-4. Unknown founders = 1-2. Red flags = 0.`

async function scoreJobWithClaude(
  client: Anthropic,
  title: string,
  company: string,
  location: string,
  description: string
): Promise<{ score: number; label: string; summary: string; lane: string | null } | null> {
  // Hard exclusions — never surface, never score.
  if (isExcludedOpportunity(company, title, description)) return null

  const lane = laneForOpportunity(company, title)
  const precheck = locationPrecheck(location, description)

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: DNA_PROMPT,
      messages: [{
        role: 'user',
        content: `${SCORING_PROMPT}

JOB TITLE: ${title}
COMPANY: ${company}
LOCATION: ${location}
LOCATION PRE-CHECK: ${precheck}
DESCRIPTION: ${description}

Return ONLY a JSON object, no markdown, no preamble:
{
  "score": <integer 0-100>,
  "label": "<Poor match|Partial match|Good match|Strong match|Exceptional match|Excluded - relocation required|Disqualified>",
  "summary": "<one sentence explaining the score or disqualification>"
}`,
      }],
    })

    const content = message.content[0]
    if (content.type !== 'text') return null

    const rawText = content.text.trim()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: Record<string, any> | null = null
    try {
      parsed = JSON.parse(rawText)
    } catch {
      const start = rawText.indexOf('{')
      const end = rawText.lastIndexOf('}')
      if (start === -1 || end === -1 || end <= start) return null
      try {
        parsed = JSON.parse(rawText.slice(start, end + 1))
      } catch {
        return null
      }
    }
    if (!parsed) return null

    const baseScore = typeof parsed.score === 'number' ? parsed.score : 0
    const label = typeof parsed.label === 'string' ? parsed.label : 'Unknown'
    // Handle AI typos in field name (summit, summery seen in prod)
    let summary =
      typeof parsed.summary === 'string' ? parsed.summary :
      typeof parsed.summit === 'string' ? parsed.summit :
      typeof parsed.summery === 'string' ? parsed.summery :
      (Object.values(parsed).find((v): v is string => typeof v === 'string' && v.length > 20) ?? '')

    // Hard-filtered results pass through untouched.
    if (baseScore === 0) return { score: 0, label, summary, lane }

    // Deterministic post-LLM adjustments: red/green flag keywords, then
    // watchlist + lane priority bonus (CJ vendor lane gets no bonus — it is
    // surfaced separately, not blended into the main score).
    const adjusted = applyKeywordAdjustments(baseScore, title, description)
    const score = Math.min(100, adjusted.score + watchlistAndLaneBonus(company, title))
    if (adjusted.redFlags.length > 0) {
      summary += ` [Red flags: ${adjusted.redFlags.join('; ')}]`
    }
    if (adjusted.greenFlags.length > 0) {
      summary += ` [Green flags: ${adjusted.greenFlags.join('; ')}]`
    }

    return { score, label, summary, lane }
  } catch {
    return null
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePostedHours(postedText: string): number {
  const text = postedText.toLowerCase()
  const minsMatch = text.match(/(\d+)\s*min/)
  if (minsMatch) return parseInt(minsMatch[1]) / 60
  const hoursMatch = text.match(/(\d+)\s*hr/)
  if (hoursMatch) return parseInt(hoursMatch[1])
  const daysMatch = text.match(/(\d+)\s*day/)
  if (daysMatch) return parseInt(daysMatch[1]) * 24
  return 999
}

function bumpSource(results: Results, source: string, delta: { fetched?: number; saved?: number }) {
  if (!results.bySource[source]) results.bySource[source] = { fetched: 0, saved: 0 }
  if (delta.fetched) results.bySource[source].fetched += delta.fetched
  if (delta.saved) results.bySource[source].saved += delta.saved
}

// ── VibeCodeCareers scraper ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function scrapeVibeCodeCareers(client: Anthropic, sql: any, results: Results) {
  try {
    const pageRes = await fetch('https://vibecodecareers.com/jobs/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    })
    const html = await pageRes.text()

    const remoteRecentUrls: string[] = []
    const seenUrls = new Set<string>()
    const articles = html.split(/<article[\s>]/)

    for (let i = 1; i < articles.length; i++) {
      const card = articles[i]

      const urlMatch = card.match(/href="(https:\/\/vibecodecareers\.com\/job\/[^"]+)"/)
      if (!urlMatch) continue
      const jobUrl = urlMatch[1]

      if (seenUrls.has(jobUrl)) continue
      seenUrls.add(jobUrl)

      if (!/\bRemote\b/i.test(card)) continue

      const postedMatch = card.match(/Posted\s+(\d+)\s*(min|hr|day)/i)
      if (!postedMatch) continue

      const amount = parseInt(postedMatch[1])
      const unit = postedMatch[2].toLowerCase()
      let hours = 999
      if (unit.startsWith('min')) hours = amount / 60
      else if (unit.startsWith('hr')) hours = amount
      else if (unit.startsWith('day')) hours = amount * 24

      if (hours <= 24) {
        remoteRecentUrls.push(jobUrl)
      }
    }

    results.fetched += remoteRecentUrls.length
    bumpSource(results, 'vibecodecareers', { fetched: remoteRecentUrls.length })

    for (const jobUrl of remoteRecentUrls) {
      try {
        const existing = await sql`SELECT id FROM job_leads WHERE url = ${jobUrl}`
        if (existing.length > 0) continue

        const detailRes = await fetch(jobUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; career-bot/1.0)',
            'Accept': 'text/html',
          },
        })
        const detailHtml = await detailRes.text()

        const titleMatch =
          detailHtml.match(/<meta\s+property="og:title"\s+content="([^"]+)"/) ||
          detailHtml.match(/<h1[^>]*>([^<]+)<\/h1>/)
        const title = titleMatch
          ? titleMatch[1].replace(' - VibeCodeCareers', '').trim()
          : 'Unknown'

        const companyMatch =
          detailHtml.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)</) ||
          detailHtml.match(/"hiringOrganization"[^}]*"name"\s*:\s*"([^"]+)"/)
        const company = companyMatch ? companyMatch[1].trim() : 'Unknown'

        const salaryMatch = detailHtml.match(/\$[\d,]+\s*[-–]\s*\$[\d,]+(?:\/yr)?/)
        const salaryDisplay = salaryMatch ? salaryMatch[0].replace('/yr', '') : null

        const bodyMatch =
          detailHtml.match(/<div[^>]*class="[^"]*job[^"]*description[^"]*"[^>]*>([\s\S]+?)<\/div>/) ||
          detailHtml.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]{200,}?)<\/div>/)
        let description = ''
        if (bodyMatch) {
          description = bodyMatch[1]
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        }

        if (description.length < 100) {
          description = detailHtml
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(500, 3000)
        }

        if (description.length < 100) continue

        const scored = await scoreJobWithClaude(client, title, company, 'Remote', description.slice(0, 2000))
        results.scored++
        if (!scored || scored.score < 60) continue

        const slug = jobUrl.split('/job/')[1]?.replace(/\//g, '') || jobUrl
        const externalId = 'vcc-' + slug

        await sql`
          INSERT INTO job_leads (
            external_id, title, company, location,
            salary_min, salary_max, salary_display,
            description, url, fit_score, fit_label, fit_summary, source, lane
          ) VALUES (
            ${externalId}, ${title}, ${company}, ${'Remote'},
            ${null}, ${null}, ${salaryDisplay},
            ${description.slice(0, 5000)}, ${jobUrl},
            ${scored.score}, ${scored.label}, ${scored.summary},
            ${'vibecodecareers'}, ${scored.lane}
          )
          ON CONFLICT (external_id) DO NOTHING
        `
        results.saved++
        bumpSource(results, 'vibecodecareers', { saved: 1 })

        await new Promise(r => setTimeout(r, 1000))

      } catch (jobErr) {
        results.errors.push(`VCC job error: ${String(jobErr)}`)
      }
    }

  } catch (err) {
    results.errors.push(`VCC scraper error: ${String(err)}`)
  }
}

// ── Ashby fetcher ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAshbyJobs(client: Anthropic, sql: any, results: Results) {
  const staticAshby = TARGET_COMPANIES.filter(c => c.ats === 'ashby')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicAshby = await sql`SELECT slug, name FROM ats_companies WHERE ats = 'ashby'`
  const ashbyCompanies = [
    ...staticAshby,
    ...dynamicAshby.map((r: { slug: string; name: string }) => ({ slug: r.slug, name: r.name, ats: 'ashby' as const })),
  ].filter((c, i, arr) => arr.findIndex(x => x.slug === c.slug) === i)

  for (const company of ashbyCompanies) {
    try {
      const res = await fetch(
        `https://api.ashbyhq.com/posting-api/job-board/${company.slug}?includeCompensation=true`,
        { headers: { 'Accept': 'application/json' } }
      )
      if (!res.ok) continue

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await res.json() as { jobs?: any[] }
      const jobs = data.jobs ?? []
      results.fetched += jobs.length
      bumpSource(results, 'ashby', { fetched: jobs.length })

      for (const job of jobs) {
        const isRemote = job.isRemote || job.workplaceType === 'Remote'
        const jobLocation = job.locationName ?? (isRemote ? 'Remote' : '')
        if (!isAustinOrRemote(jobLocation, isRemote)) continue

        const externalId = `ashby-${job.id}`
        const existing = await sql`SELECT id FROM job_leads WHERE external_id = ${externalId}`
        if (existing.length > 0) continue

        let salaryMin: number | null = null
        let salaryMax: number | null = null
        let salaryDisplay: string | null = null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const salaryTier = job.compensation?.compensationTiers?.find((t: any) => t.type === 'Salary')
        if (salaryTier) {
          salaryMin = salaryTier.minValue ?? null
          salaryMax = salaryTier.maxValue ?? null
          if (salaryMin && salaryMax) {
            salaryDisplay = `$${Math.round(salaryMin / 1000)}K – $${Math.round(salaryMax / 1000)}K`
          }
        }

        const description = (job.descriptionHtml ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()

        if (description.length < 100) continue

        const scored = await scoreJobWithClaude(
          client, job.title, company.name, jobLocation || 'Remote', description.slice(0, 2000)
        )
        if (!scored || scored.score < 60) continue
        results.scored++

        await sql`
          INSERT INTO job_leads (
            external_id, title, company, location,
            salary_min, salary_max, salary_display,
            description, url, fit_score, fit_label, fit_summary, source, lane
          ) VALUES (
            ${externalId}, ${job.title}, ${company.name}, ${jobLocation || 'Remote'},
            ${salaryMin}, ${salaryMax}, ${salaryDisplay},
            ${description.slice(0, 5000)}, ${job.jobUrl},
            ${scored.score}, ${scored.label}, ${scored.summary},
            ${'ashby'}, ${scored.lane}
          )
          ON CONFLICT (external_id) DO NOTHING
        `
        results.saved++
        bumpSource(results, 'ashby', { saved: 1 })
        await new Promise(r => setTimeout(r, 500))
      }
    } catch (err) {
      results.errors.push(`Ashby error for ${company.slug}: ${String(err)}`)
    }
  }
}

// ── Lever fetcher ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchLeverJobs(client: Anthropic, sql: any, results: Results) {
  const staticLever = TARGET_COMPANIES.filter(c => c.ats === 'lever')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicLever = await sql`SELECT slug, name FROM ats_companies WHERE ats = 'lever'`
  const leverCompanies = [
    ...staticLever,
    ...dynamicLever.map((r: { slug: string; name: string }) => ({ slug: r.slug, name: r.name, ats: 'lever' as const })),
  ].filter((c, i, arr) => arr.findIndex(x => x.slug === c.slug) === i)

  for (const company of leverCompanies) {
    try {
      const res = await fetch(
        `https://api.lever.co/v0/postings/${company.slug}?mode=json`,
        { headers: { 'Accept': 'application/json' } }
      )
      if (!res.ok) continue

      const jobs = await res.json()
      if (!Array.isArray(jobs)) continue
      results.fetched += jobs.length
      bumpSource(results, 'lever', { fetched: jobs.length })

      for (const job of jobs) {
        const isRemote =
          job.workplaceType === 'remote' ||
          (job.categories?.location ?? '').toLowerCase().includes('remote')
        if (!isAustinOrRemote(job.categories?.location ?? '', isRemote)) continue

        const externalId = `lever-${job.id}`
        const existing = await sql`SELECT id FROM job_leads WHERE external_id = ${externalId}`
        if (existing.length > 0) continue

        let salaryMin: number | null = null
        let salaryMax: number | null = null
        let salaryDisplay: string | null = null
        if (job.salaryRange) {
          salaryMin = job.salaryRange.min ?? null
          salaryMax = job.salaryRange.max ?? null
          if (salaryMin && salaryMax) {
            salaryDisplay = `$${Math.round(salaryMin / 1000)}K – $${Math.round(salaryMax / 1000)}K`
          }
        }

        const description = (job.descriptionPlain ?? job.description ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()

        if (description.length < 100) continue

        const jobLocation = job.categories?.location ?? 'Remote'
        const scored = await scoreJobWithClaude(
          client, job.text, company.name, jobLocation, description.slice(0, 2000)
        )
        if (!scored || scored.score < 60) continue
        results.scored++

        await sql`
          INSERT INTO job_leads (
            external_id, title, company, location,
            salary_min, salary_max, salary_display,
            description, url, fit_score, fit_label, fit_summary, source, lane
          ) VALUES (
            ${externalId}, ${job.text}, ${company.name}, ${jobLocation},
            ${salaryMin}, ${salaryMax}, ${salaryDisplay},
            ${description.slice(0, 5000)}, ${job.hostedUrl ?? job.applyUrl},
            ${scored.score}, ${scored.label}, ${scored.summary},
            ${'lever'}, ${scored.lane}
          )
          ON CONFLICT (external_id) DO NOTHING
        `
        results.saved++
        bumpSource(results, 'lever', { saved: 1 })
        await new Promise(r => setTimeout(r, 500))
      }
    } catch (err) {
      results.errors.push(`Lever error for ${company.slug}: ${String(err)}`)
    }
  }
}

// ── Greenhouse fetcher ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchGreenhouseJobs(client: Anthropic, sql: any, results: Results) {
  const staticGH = TARGET_COMPANIES.filter(c => c.ats === 'greenhouse')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicGH = await sql`SELECT slug, name FROM ats_companies WHERE ats = 'greenhouse'`
  const ghCompanies = [
    ...staticGH,
    ...dynamicGH.map((r: { slug: string; name: string }) => ({ slug: r.slug, name: r.name, ats: 'greenhouse' as const })),
  ].filter((c, i, arr) => arr.findIndex(x => x.slug === c.slug) === i)

  for (const company of ghCompanies) {
    try {
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs?content=true`,
        { headers: { 'Accept': 'application/json' } }
      )
      if (!res.ok) continue

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await res.json() as { jobs?: any[] }
      const jobs = data.jobs ?? []
      results.fetched += jobs.length
      bumpSource(results, 'greenhouse', { fetched: jobs.length })

      for (const job of jobs) {
        const locationStr = (job.location?.name ?? '').toLowerCase()
        const isRemote = locationStr.includes('remote') || locationStr.includes('anywhere')
        if (!isAustinOrRemote(job.location?.name ?? '', isRemote)) continue

        const externalId = `greenhouse-${job.id}`
        const existing = await sql`SELECT id FROM job_leads WHERE external_id = ${externalId}`
        if (existing.length > 0) continue

        const description = (job.content ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()

        if (description.length < 100) continue

        const jobLocation = job.location?.name ?? 'Remote'
        const scored = await scoreJobWithClaude(
          client, job.title, company.name, jobLocation, description.slice(0, 2000)
        )
        if (!scored || scored.score < 60) continue
        results.scored++

        await sql`
          INSERT INTO job_leads (
            external_id, title, company, location,
            salary_min, salary_max, salary_display,
            description, url, fit_score, fit_label, fit_summary, source, lane
          ) VALUES (
            ${externalId}, ${job.title}, ${company.name}, ${jobLocation},
            ${null}, ${null}, ${null},
            ${description.slice(0, 5000)}, ${job.absolute_url},
            ${scored.score}, ${scored.label}, ${scored.summary},
            ${'greenhouse'}, ${scored.lane}
          )
          ON CONFLICT (external_id) DO NOTHING
        `
        results.saved++
        bumpSource(results, 'greenhouse', { saved: 1 })
        await new Promise(r => setTimeout(r, 500))
      }
    } catch (err) {
      results.errors.push(`Greenhouse error for ${company.slug}: ${String(err)}`)
    }
  }
}

// ── AEC Tech Jobs RSS fetcher ─────────────────────────────────────────────────

// The aectechjobs Substack feed mixes job postings ("Senior Estimator at Turner")
// with newsletter/blog posts ("A Holiday Thank You (and what's ahead in 2026)",
// "Why Not You?"). Filter out items that have neither a "<Title> at <Company>"
// structure nor any recognizable role keyword — conservative on purpose so a
// real posting with an unusual title is not dropped.
const AEC_ROLE_KEYWORD_RE = /\b(engineer|analyst|manager|developer|designer|director|specialist|coordinator|estimator|architect|scientist|consultant|lead|bim|vdc|precon(?:struction)?|product|superintendent|technologist)\b/i

function isLikelyNewsletterItem(title: string): boolean {
  const hasAtCompany = /\bat\s+\S+/i.test(title)
  const hasRoleKeyword = AEC_ROLE_KEYWORD_RE.test(title)
  return !hasAtCompany && !hasRoleKeyword
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAecTechJobsRSS(client: Anthropic, sql: any, results: Results) {
  try {
    const res = await fetch('https://aectechjobs.substack.com/feed', {
      headers: { 'Accept': 'application/rss+xml, application/xml, text/xml' },
    })
    if (!res.ok) return

    const xml = await res.text()
    const items = xml.split('<item>')
    results.fetched += items.length - 1
    bumpSource(results, 'aectechjobs', { fetched: items.length - 1 })

    for (let i = 1; i < items.length; i++) {
      const item = items[i]

      const titleMatch =
        item.match(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/) ||
        item.match(/<title>([^<]+)<\/title>/)
      const linkMatch =
        item.match(/<link>([^<]+)<\/link>/) ||
        item.match(/<guid[^>]*>([^<]+)<\/guid>/)
      const descMatch =
        item.match(/<description><!\[CDATA\[([\s\S]+?)\]\]><\/description>/) ||
        item.match(/<description>([^<]+)<\/description>/)

      if (!titleMatch || !linkMatch) continue

      const title = titleMatch[1].trim()
      if (isLikelyNewsletterItem(title)) continue
      const url = linkMatch[1].trim()
      const rawDesc = descMatch ? descMatch[1] : ''
      const description = rawDesc
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      if (description.length < 50) continue

      const externalId = `aectechjobs-${Buffer.from(url).toString('base64').slice(0, 32)}`
      const existing = await sql`SELECT id FROM job_leads WHERE external_id = ${externalId}`
      if (existing.length > 0) continue

      const atMatch = title.match(/\bat\s+(.+)$/i)
      const company = atMatch ? atMatch[1].trim() : 'AEC Tech Company'
      const jobTitle = atMatch ? title.replace(atMatch[0], '').trim() : title

      const scored = await scoreJobWithClaude(
        client, jobTitle, company, 'Remote', description.slice(0, 2000)
      )
      if (!scored || scored.score < 60) continue
      results.scored++

      await sql`
        INSERT INTO job_leads (
          external_id, title, company, location,
          salary_min, salary_max, salary_display,
          description, url, fit_score, fit_label, fit_summary, source, lane
        ) VALUES (
          ${externalId}, ${jobTitle}, ${company}, ${'Remote'},
          ${null}, ${null}, ${null},
          ${description.slice(0, 5000)}, ${url},
          ${scored.score}, ${scored.label}, ${scored.summary},
          ${'aectechjobs'}, ${scored.lane}
        )
        ON CONFLICT (external_id) DO NOTHING
      `
      results.saved++
      bumpSource(results, 'aectechjobs', { saved: 1 })
      await new Promise(r => setTimeout(r, 500))
    }
  } catch (err) {
    results.errors.push(`AEC Tech Jobs RSS error: ${String(err)}`)
  }
}

// ── ATS company discovery ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function discoverAndVerifyATSCompanies(sql: any, results: Results) {
  // Probe list = the target company watchlist (Analytics/Data + CJ vendor
  // lanes). The prior GTM/AEC-tech discovery list and Procore-marketplace
  // name harvesting were removed in the 2026-07 retarget — the watchlist is
  // now explicit, not discovered.
  const companyNames: string[] = [
    ...WATCHLIST['analytics-data'],
    ...WATCHLIST['cj-vendor'],
  ]

  const uniqueNames = Array.from(new Set(companyNames))

  // Step C: Load already-verified slugs to avoid re-probing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alreadyVerified = await sql`SELECT slug, ats FROM ats_companies`
  const verifiedSet = new Set(
    alreadyVerified.map((r: { slug: string; ats: string }) => `${r.slug}:${r.ats}`)
  )

  let newDiscoveries = 0

  for (const name of uniqueNames.slice(0, 15)) {
    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')

    const slugCandidates = [
      baseSlug,
      baseSlug.replace(/-/g, ''),
      baseSlug.replace(/-inc$|-llc$|-corp$/, ''),
      baseSlug.replace(/-ai$/, '') + 'ai',
      baseSlug + '-inc',
    ].filter((s, i, arr) => s.length > 1 && arr.indexOf(s) === i)

    for (const slug of slugCandidates) {
      // Probe Ashby
      if (!verifiedSet.has(`${slug}:ashby`)) {
        try {
          const r = await fetch(
            `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
            { signal: AbortSignal.timeout(1500) }
          )
          if (r.ok) {
            await sql`
              INSERT INTO ats_companies (slug, name, ats)
              VALUES (${slug}, ${name}, 'ashby')
              ON CONFLICT (slug, ats) DO UPDATE SET last_checked = NOW()
            `
            verifiedSet.add(`${slug}:ashby`)
            newDiscoveries++
          }
        } catch { /* timeout or network error — skip */ }
      }

      // Probe Lever
      if (!verifiedSet.has(`${slug}:lever`)) {
        try {
          const r = await fetch(
            `https://api.lever.co/v0/postings/${slug}?mode=json`,
            { signal: AbortSignal.timeout(1500) }
          )
          if (r.ok) {
            await sql`
              INSERT INTO ats_companies (slug, name, ats)
              VALUES (${slug}, ${name}, 'lever')
              ON CONFLICT (slug, ats) DO UPDATE SET last_checked = NOW()
            `
            verifiedSet.add(`${slug}:lever`)
            newDiscoveries++
          }
        } catch { /* timeout or network error — skip */ }
      }

      // Probe Greenhouse
      if (!verifiedSet.has(`${slug}:greenhouse`)) {
        try {
          const r = await fetch(
            `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
            { signal: AbortSignal.timeout(1500) }
          )
          if (r.ok) {
            await sql`
              INSERT INTO ats_companies (slug, name, ats)
              VALUES (${slug}, ${name}, 'greenhouse')
              ON CONFLICT (slug, ats) DO UPDATE SET last_checked = NOW()
            `
            verifiedSet.add(`${slug}:greenhouse`)
            newDiscoveries++
          }
        } catch { /* timeout or network error — skip */ }
      }

    }
  }

  results.errors.push(`ATS discovery: ${newDiscoveries} new companies verified`)
}

// ── YC Work at a Startup ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchYCFallback(client: Anthropic, sql: any, results: Results) {
  try {
    const res = await fetch(
      'https://www.workatastartup.com/jobs?role=operations&remote=only&jobType=fulltime',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
      }
    )
    if (!res.ok) return
    const html = await res.text()

    const jobUrls = Array.from(new Set(
      Array.from(html.matchAll(/href="(\/jobs\/\d+[^"]+)"/g))
        .map(m => `https://www.workatastartup.com${m[1]}`)
    )).slice(0, 8)

    results.fetched += jobUrls.length
    bumpSource(results, 'ycombinator', { fetched: jobUrls.length })

    for (const jobUrl of jobUrls) {
      const externalId = `yc-${Buffer.from(jobUrl).toString('base64').slice(0, 24)}`
      const existing = await sql`SELECT id FROM job_leads WHERE external_id = ${externalId}`
      if (existing.length > 0) continue

      try {
        const detailRes = await fetch(jobUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-bot/1.0)' },
        })
        const detailHtml = await detailRes.text()

        const titleMatch =
          detailHtml.match(/<h1[^>]*>([^<]+)<\/h1>/) ||
          detailHtml.match(/<meta property="og:title" content="([^"]+)"/)
        const companyMatch =
          detailHtml.match(/"company"[^}]*"name"\s*:\s*"([^"]+)"/) ||
          detailHtml.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)</)

        const title = titleMatch?.[1]?.trim() ?? 'Unknown'
        const company = companyMatch?.[1]?.trim() ?? 'YC Company'

        const description = detailHtml
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(500, 3500)

        if (description.length < 100) continue

        const scored = await scoreJobWithClaude(
          client, title, company, 'Remote', description.slice(0, 2000)
        )
        if (!scored || scored.score < 60) continue
        results.scored++

        await sql`
          INSERT INTO job_leads (
            external_id, title, company, location,
            salary_min, salary_max, salary_display,
            description, url, fit_score, fit_label, fit_summary, source, lane
          ) VALUES (
            ${externalId}, ${title}, ${company}, ${'Remote'},
            ${null}, ${null}, ${null},
            ${description.slice(0, 5000)}, ${jobUrl},
            ${scored.score}, ${scored.label}, ${scored.summary},
            ${'ycombinator'}, ${scored.lane}
          )
          ON CONFLICT (external_id) DO NOTHING
        `
        results.saved++
        bumpSource(results, 'ycombinator', { saved: 1 })
        await new Promise(r => setTimeout(r, 500))
      } catch (jobErr) {
        results.errors.push(`YC job error: ${String(jobErr)}`)
      }
    }
  } catch (err) {
    results.errors.push(`YC fallback error: ${String(err)}`)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchYCJobs(client: Anthropic, sql: any, results: Results) {
  try {
    const res = await fetch(
      'https://api.workatastartup.com/companies/search?' +
      'query=&' +
      'remote=only&' +
      'role=operations&' +
      'jobType=fulltime&' +
      'companySize=seed,small&' +
      'industry=Real%20Estate%20and%20Construction,B2B%20Software%20and%20Services',
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; career-bot/1.0)',
          'X-Requested-With': 'XMLHttpRequest',
        },
      }
    )

    if (!res.ok) {
      results.errors.push(`YC API returned ${res.status} — trying fallback`)
      await fetchYCFallback(client, sql, results)
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as { jobs?: any[]; hits?: any[]; results?: any[] }
    const jobs = data.jobs ?? data.hits ?? data.results ?? []
    results.fetched += jobs.length
    bumpSource(results, 'ycombinator', { fetched: jobs.length })

    if (jobs.length === 0) {
      // API responded but returned no jobs — run fallback scraper
      await fetchYCFallback(client, sql, results)
      return
    }

    for (const job of jobs) {
      const title = job.title ?? job.job_title ?? ''
      const company = job.company_name ?? job.company?.name ?? ''
      const jobUrl = job.url ?? job.job_url ?? `https://www.workatastartup.com/jobs/${job.id}`
      const description = (job.description ?? job.job_description ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      if (!title || description.length < 100) continue

      const externalId = `yc-${job.id ?? Buffer.from(jobUrl).toString('base64').slice(0, 24)}`
      const existing = await sql`SELECT id FROM job_leads WHERE external_id = ${externalId}`
      if (existing.length > 0) continue

      const scored = await scoreJobWithClaude(
        client, title, company, 'Remote', description.slice(0, 2000)
      )
      if (!scored || scored.score < 60) continue
      results.scored++

      await sql`
        INSERT INTO job_leads (
          external_id, title, company, location,
          salary_min, salary_max, salary_display,
          description, url, fit_score, fit_label, fit_summary, source, lane
        ) VALUES (
          ${externalId}, ${title}, ${company}, ${'Remote'},
          ${null}, ${null}, ${null},
          ${description.slice(0, 5000)}, ${jobUrl},
          ${scored.score}, ${scored.label}, ${scored.summary},
          ${'ycombinator'}, ${scored.lane}
        )
        ON CONFLICT (external_id) DO NOTHING
      `
      results.saved++
      bumpSource(results, 'ycombinator', { saved: 1 })
      await new Promise(r => setTimeout(r, 500))
    }
  } catch (err) {
    results.errors.push(`YC scraper error: ${String(err)}`)
    await fetchYCFallback(client, sql, results)
  }
}

// ── GET handler ───────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await initDb()
  const sql = getDb()
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const results: Results = {
    fetched: 0,
    scored: 0,
    saved: 0,
    errors: [],
    bySource: {},
  }

  // ── Adzuna ──────────────────────────────────────────────────────────────────

  for (const title of SEARCH_TITLES) {
    try {
      const query = encodeURIComponent(title)
      const url =
        `https://api.adzuna.com/v1/api/jobs/us/search/1` +
        `?app_id=${ADZUNA_APP_ID}` +
        `&app_key=${ADZUNA_APP_KEY}` +
        `&results_per_page=5` +
        `&what=${query}` +
        `&full_time=1` +
        `&sort_by=date`

      const res = await fetch(url)
      const data = await res.json()
      const jobs = data.results || []
      results.fetched += jobs.length
      bumpSource(results, 'adzuna', { fetched: jobs.length })

      for (const job of jobs) {
        const existing = await sql`SELECT id FROM job_leads WHERE external_id = ${job.id}`
        if (existing.length > 0) continue

        const description = job.description || ''
        if (description.length < 100) continue

        try {
          const scored = await scoreJobWithClaude(
            client,
            job.title,
            job.company?.display_name || 'Unknown',
            job.location?.display_name || 'Unknown',
            description.slice(0, 2000)
          )
          results.scored++
          if (!scored || scored.score < 70) continue

          const salaryMin = job.salary_min ? Math.round(job.salary_min) : null
          const salaryMax = job.salary_max ? Math.round(job.salary_max) : null
          const salaryDisplay = salaryMin && salaryMax
            ? `$${(salaryMin / 1000).toFixed(0)}K – $${(salaryMax / 1000).toFixed(0)}K`
            : salaryMin
              ? `$${(salaryMin / 1000).toFixed(0)}K+`
              : null

          await sql`
            INSERT INTO job_leads (
              external_id, title, company, location,
              salary_min, salary_max, salary_display,
              description, url, fit_score, fit_label, fit_summary, source, lane
            ) VALUES (
              ${String(job.id)},
              ${job.title},
              ${job.company?.display_name || 'Unknown'},
              ${job.location?.display_name || null},
              ${salaryMin}, ${salaryMax}, ${salaryDisplay},
              ${description},
              ${job.redirect_url},
              ${scored.score}, ${scored.label}, ${scored.summary},
              ${'adzuna'}, ${scored.lane}
            )
            ON CONFLICT (external_id) DO NOTHING
          `
          results.saved++
          bumpSource(results, 'adzuna', { saved: 1 })

        } catch (scoreErr) {
          results.errors.push(`Score error for ${job.id}: ${String(scoreErr)}`)
        }

        await new Promise(r => setTimeout(r, 500))
      }

    } catch (fetchErr) {
      results.errors.push(`Fetch error for "${title}": ${String(fetchErr)}`)
    }
  }

  // ── Additional sources ──────────────────────────────────────────────────────

  await scrapeVibeCodeCareers(client, sql, results)

  // Discover new ATS companies from Procore + known list, then poll all verified companies
  await discoverAndVerifyATSCompanies(sql, results)
  await fetchAshbyJobs(client, sql, results)
  await fetchLeverJobs(client, sql, results)
  await fetchGreenhouseJobs(client, sql, results)

  // YC Work at a Startup
  await fetchYCJobs(client, sql, results)

  // AEC Tech Jobs RSS
  await fetchAecTechJobsRSS(client, sql, results)

  return Response.json({ success: true, ...results })
}
