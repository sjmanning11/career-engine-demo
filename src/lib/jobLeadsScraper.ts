import { parse as parseHtml } from 'node-html-parser'
import type { Lane } from '@/lib/targeting'

// ── Types ─────────────────────────────────────────────────────────────────────

export type JobLead = {
  externalId: string
  company: string
  title: string
  location: string
  isRemote: boolean
  locationUnverified: boolean
  requiresManualReview: boolean
  applyUrl: string
  description: string
  scrapedAt: string
  source: 'target-ashby' | 'target-greenhouse' | 'target-custom'
  lane: Lane
}

type AshbyTarget      = { name: string; type: 'ashby';      slug: string; lane: Lane }
type GreenhouseTarget = { name: string; type: 'greenhouse'; slug: string; lane: Lane }
type CustomTarget     = { name: string; type: 'custom';     url: string;  lane: Lane }
type Target = AshbyTarget | GreenhouseTarget | CustomTarget

// ── Target company watchlist (2026-07 retarget) ──────────────────────────────
// Grouped by lane. Analytics/Data is the primary lane; the CJ vendor lane is
// exploratory and surfaced separately. Custom career-page URLs degrade
// gracefully to manual-review placeholders if a scrape fails.

export const TARGETS: Target[] = [
  // ── Analytics / Data lane (also serves FP&A roles at the same employers) ──
  { name: 'Procore',                     type: 'custom', url: 'https://careers.procore.com',                      lane: 'analytics-data' },
  { name: 'Autodesk',                    type: 'custom', url: 'https://www.autodesk.com/careers',                 lane: 'analytics-data' },
  { name: 'Document Crunch',             type: 'custom', url: 'https://www.documentcrunch.com/careers#open-roles', lane: 'analytics-data' },
  { name: 'Billd',                       type: 'custom', url: 'https://billd.com/careers',                        lane: 'analytics-data' },
  { name: 'Aurigo',                      type: 'custom', url: 'https://www.aurigo.com/careers/',                  lane: 'analytics-data' },
  { name: 'Built Technologies',          type: 'custom', url: 'https://getbuilt.com/careers',                     lane: 'analytics-data' },
  { name: 'Trimble',                     type: 'custom', url: 'https://careers.trimble.com',                      lane: 'analytics-data' },
  { name: 'Dell',                        type: 'custom', url: 'https://jobs.dell.com',                            lane: 'analytics-data' },
  { name: 'Samsung Austin Semiconductor', type: 'custom', url: 'https://semiconductor.samsung.com/us/sas/careers/', lane: 'analytics-data' },
  { name: 'Texas Mutual Insurance',      type: 'custom', url: 'https://www.texasmutual.com/careers',              lane: 'analytics-data' },
  { name: 'Apple',                       type: 'custom', url: 'https://jobs.apple.com/en-us/search?location=austin-AST', lane: 'analytics-data' },
  { name: 'GM IT Innovation Center',     type: 'custom', url: 'https://careers.gm.com',                           lane: 'analytics-data' },
  { name: 'Q2',                          type: 'custom', url: 'https://www.q2.com/careers',                       lane: 'analytics-data' },
  { name: 'Indeed',                      type: 'custom', url: 'https://www.indeed.com/careers',                   lane: 'analytics-data' },
  { name: 'Charles Schwab',              type: 'custom', url: 'https://www.schwabjobs.com',                       lane: 'analytics-data' },
  { name: 'CoStar',                      type: 'custom', url: 'https://careers.costargroup.com',                  lane: 'analytics-data' },
  // ERCOT: market/settlement analyst desk only — NOT control-room shift roles.
  { name: 'ERCOT',                       type: 'custom', url: 'https://www.ercot.com/about/careers',              lane: 'analytics-data' },

  // ── Criminal-justice vendor lane (exploratory — surfaced separately) ──────
  { name: 'Tyler Technologies',          type: 'custom', url: 'https://www.tylertech.com/careers',                lane: 'cj-vendor' },
  { name: 'Axon',                        type: 'custom', url: 'https://www.axon.com/careers',                     lane: 'cj-vendor' },
  { name: 'LexisNexis Risk Solutions',   type: 'custom', url: 'https://risk.lexisnexis.com/careers',              lane: 'cj-vendor' },
  { name: 'Recidiviz',                   type: 'custom', url: 'https://www.recidiviz.org/careers',                lane: 'cj-vendor' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if the job is fully remote or located within the Austin-area
 * commute radius from Georgetown TX (78626).
 */
export function isAustinOrRemote(locationString: string, isRemote: boolean): boolean {
  if (isRemote) return true
  if (!locationString) return false
  const loc = locationString.toLowerCase()
  const remoteKeywords = ['remote', 'anywhere', 'distributed', 'worldwide', 'global']
  const austinKeywords = [
    'austin', 'georgetown', 'round rock', 'cedar park',
    'pflugerville', 'taylor',
  ]
  return (
    remoteKeywords.some(k => loc.includes(k)) ||
    austinKeywords.some(k => loc.includes(k))
  )
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function simpleHash(str: string): string {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

function manualReviewPlaceholder(
  company: string,
  careerUrl: string,
  reason: string,
  source: JobLead['source'],
  lane: Lane,
  idSuffix = 'manual',
): JobLead {
  return {
    externalId:          `target-manual-${slugify(company)}-${idSuffix}`,
    company,
    title:               'Check careers page manually',
    location:            '',
    isRemote:            false,
    locationUnverified:  true,
    requiresManualReview: true,
    applyUrl:            careerUrl,
    description:         reason,
    scrapedAt:           new Date().toISOString(),
    source,
    lane,
  }
}

// ── Ashby scraper ─────────────────────────────────────────────────────────────

async function scrapeAshby(target: AshbyTarget): Promise<JobLead[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${target.slug}?includeCompensation=false`
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  type AshbyJob = {
    id: string
    title: string
    isRemote: boolean
    workplaceType: string
    locationName?: string
    jobUrl: string
    descriptionHtml?: string
  }
  const data = await res.json() as { jobs?: AshbyJob[] }
  const jobs = data.jobs ?? []
  const now  = new Date().toISOString()
  const results: JobLead[] = []

  for (const job of jobs) {
    const remote   = job.isRemote || job.workplaceType === 'Remote'
    const location = job.locationName ?? (remote ? 'Remote' : '')
    if (!isAustinOrRemote(location, remote)) continue

    const description = (job.descriptionHtml ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    results.push({
      externalId:           `target-ashby-${slugify(target.slug)}-${job.id}`,
      company:              target.name,
      title:                job.title,
      location:             location || 'Remote',
      isRemote:             remote,
      locationUnverified:   false,
      requiresManualReview: false,
      applyUrl:             job.jobUrl,
      description:          description.slice(0, 5_000),
      scrapedAt:            now,
      source:               'target-ashby',
      lane:                 target.lane,
    })
  }
  return results
}

// ── Greenhouse scraper ────────────────────────────────────────────────────────

async function scrapeGreenhouse(target: GreenhouseTarget): Promise<JobLead[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${target.slug}/jobs?content=true`
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  type GHJob = {
    id: number
    title: string
    location: { name: string }
    absolute_url: string
    content?: string
  }
  const data = await res.json() as { jobs?: GHJob[] }
  const jobs = data.jobs ?? []
  const now  = new Date().toISOString()
  const results: JobLead[] = []

  for (const job of jobs) {
    const locationStr = job.location?.name ?? ''
    const remote = locationStr.toLowerCase().includes('remote') ||
                   locationStr.toLowerCase().includes('anywhere')
    if (!isAustinOrRemote(locationStr, remote)) continue

    const description = (job.content ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    results.push({
      externalId:           `target-gh-${target.slug}-${job.id}`,
      company:              target.name,
      title:                job.title,
      location:             locationStr || 'Remote',
      isRemote:             remote,
      locationUnverified:   false,
      requiresManualReview: false,
      applyUrl:             job.absolute_url,
      description:          description.slice(0, 5_000),
      scrapedAt:            now,
      source:               'target-greenhouse',
      lane:                 target.lane,
    })
  }
  return results
}

// ── Custom page scraper ───────────────────────────────────────────────────────

async function scrapeCustomPage(target: CustomTarget): Promise<JobLead[]> {
  // Strip fragment — fetch() does not send fragments to the server
  const fetchUrl = target.url.split('#')[0]
  const source: JobLead['source'] = 'target-custom'
  const now = new Date().toISOString()

  let html: string
  try {
    const res = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      return [manualReviewPlaceholder(
        target.name, target.url,
        `Automated scrape returned HTTP ${res.status}. Visit ${target.url} directly.`,
        source, target.lane,
      )]
    }
    html = await res.text()
  } catch (err) {
    return [manualReviewPlaceholder(
      target.name, target.url,
      `Fetch failed: ${err instanceof Error ? err.message : String(err)}. Visit ${target.url} directly.`,
      source, target.lane,
    )]
  }

  // Very short response = JS-rendered SPA shell, nothing to parse
  if (html.length < 500) {
    return [manualReviewPlaceholder(
      target.name, target.url,
      `Page returned minimal HTML (likely JS-rendered). Visit ${target.url} directly.`,
      source, target.lane,
      'spa',
    )]
  }

  const root    = parseHtml(html)
  const results: JobLead[] = []
  const seen    = new Set<string>()

  // ── Strategy 1: JSON-LD structured data ───────────────────────────────────
  for (const el of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const raw  = JSON.parse(el.text)
      const items = Array.isArray(raw) ? raw : [raw]
      for (const item of items) {
        if (item['@type'] !== 'JobPosting') continue
        const title = String(item.title ?? '').trim()
        if (!title || seen.has(title)) continue

        const locCity  = item.jobLocation?.address?.addressLocality ?? ''
        const locState = item.jobLocation?.address?.addressRegion   ?? ''
        const locName  = [locCity, locState].filter(Boolean).join(', ')
        const remote   = item.jobLocationType === 'TELECOMMUTE'

        if (!isAustinOrRemote(locName, remote) && locName) continue // skip clear non-matches
        seen.add(title)

        const applyRaw = item.url ?? item.sameAs ?? target.url
        const applyUrl = typeof applyRaw === 'string' ? applyRaw : target.url
        const desc     = String(item.description ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()

        results.push({
          externalId:           `target-custom-${slugify(target.name)}-${simpleHash(title)}`,
          company:              target.name,
          title,
          location:             remote ? 'Remote' : (locName || 'See posting'),
          isRemote:             remote,
          locationUnverified:   !locName && !remote,
          requiresManualReview: !locName && !remote,
          applyUrl,
          description:          desc.slice(0, 5_000),
          scrapedAt:            now,
          source,
          lane:                 target.lane,
        })
      }
    } catch { /* invalid JSON-LD — skip silently */ }
  }

  if (results.length > 0) return results

  // ── Strategy 2: detect Greenhouse/Lever/Ashby embed boards ───────────────
  const ghMatch  = html.match(/boards\.greenhouse\.io\/([a-zA-Z0-9_-]+)/)
  const leverMatch = html.match(/jobs\.lever\.co\/([a-zA-Z0-9_-]+)/)
  if (ghMatch) {
    return [manualReviewPlaceholder(
      target.name,
      `https://boards.greenhouse.io/${ghMatch[1]}`,
      `This company embeds a Greenhouse board (slug: ${ghMatch[1]}). Visit directly or add to Greenhouse targets list.`,
      source, target.lane, 'gh-embed',
    )]
  }
  if (leverMatch) {
    return [manualReviewPlaceholder(
      target.name,
      `https://jobs.lever.co/${leverMatch[1]}`,
      `This company embeds a Lever board (slug: ${leverMatch[1]}). Visit directly.`,
      source, target.lane, 'lever-embed',
    )]
  }

  // ── Strategy 3: DOM heuristics ────────────────────────────────────────────
  const titleKeywords = [
    'engineer', 'manager', 'director', 'designer', 'analyst',
    'operations', 'product', 'sales', 'marketing', 'developer',
    'lead', 'head of', 'vp of', 'chief', 'specialist', 'coordinator',
    'associate', 'senior', 'principal', 'founding',
  ]

  const candidateEls = [
    ...root.querySelectorAll('a'),
    ...root.querySelectorAll('h2'),
    ...root.querySelectorAll('h3'),
    ...root.querySelectorAll('h4'),
    ...root.querySelectorAll('[class*="job"]'),
    ...root.querySelectorAll('[class*="position"]'),
    ...root.querySelectorAll('[class*="role"]'),
    ...root.querySelectorAll('[class*="opening"]'),
  ]

  for (const el of candidateEls) {
    const text  = el.text.replace(/\s+/g, ' ').trim()
    if (text.length < 4 || text.length > 130) continue
    const lower = text.toLowerCase()
    if (!titleKeywords.some(k => lower.includes(k))) continue
    if (seen.has(text)) continue
    seen.add(text)

    // Walk up to find nearest block parent for context
    let parentEl = el.parentNode
    for (let i = 0; i < 3 && parentEl; i++) {
      const tag = (parentEl as typeof el).tagName?.toLowerCase() ?? ''
      if (['li', 'article', 'section'].includes(tag)) break
      parentEl = (parentEl as typeof el).parentNode
    }
    const parentText = parentEl ? (parentEl as typeof el).text.replace(/\s+/g, ' ').trim() : ''
    const context    = (parentText + ' ' + text).toLowerCase()
    const isRemote   = context.includes('remote') || context.includes('distributed')
    const hasAustin  = ['austin', ' tx', 'texas'].some(k => context.includes(k))

    // Skip roles that are clearly in a different city
    const otherCities = ['new york', 'san francisco', 'seattle', 'chicago', 'boston', 'los angeles', 'denver', 'london', 'toronto']
    if (!isRemote && !hasAustin && otherCities.some(c => context.includes(c))) continue

    const rawHref  = el.getAttribute('href') ?? ''
    let applyUrl   = rawHref
    if (applyUrl && !applyUrl.startsWith('http')) {
      try { applyUrl = new URL(rawHref, target.url).href } catch { applyUrl = target.url }
    }
    if (!applyUrl) applyUrl = target.url

    results.push({
      externalId:           `target-custom-${slugify(target.name)}-${simpleHash(text)}`,
      company:              target.name,
      title:                text,
      location:             isRemote ? 'Remote' : hasAustin ? 'Austin, TX' : 'See posting',
      isRemote,
      locationUnverified:   !isRemote && !hasAustin,
      requiresManualReview: !isRemote && !hasAustin,
      applyUrl,
      description:          parentText.slice(0, 1_000),
      scrapedAt:            now,
      source,
      lane:                 target.lane,
    })
  }

  if (results.length > 0) return results

  // ── Nothing parsed — return manual review placeholder ─────────────────────
  return [manualReviewPlaceholder(
    target.name, target.url,
    `Could not parse job listings automatically (may be JS-rendered or bot-protected). Visit ${target.url} directly.`,
    source, target.lane, 'no-parse',
  )]
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function scrapeAllTargets(): Promise<{ leads: JobLead[]; errors: string[] }> {
  const leads:  JobLead[] = []
  const errors: string[]  = []

  for (const target of TARGETS) {
    try {
      let batch: JobLead[] = []
      if      (target.type === 'ashby')      batch = await scrapeAshby(target)
      else if (target.type === 'greenhouse') batch = await scrapeGreenhouse(target)
      else                                   batch = await scrapeCustomPage(target)

      leads.push(...batch)
      console.log(`[curated-scraper] ${target.name}: ${batch.length} lead(s)`)

    } catch (err) {
      const msg = `${target.name}: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[curated-scraper] ERROR ${msg}`)
      errors.push(msg)

      // Always store a placeholder so Sam knows the scrape failed
      const careerUrl =
        target.type === 'custom'       ? target.url :
        target.type === 'ashby'        ? `https://jobs.ashbyhq.com/${target.slug}` :
                                         `https://boards.greenhouse.io/${target.slug}`

      const src: JobLead['source'] =
        target.type === 'ashby'        ? 'target-ashby' :
        target.type === 'greenhouse'   ? 'target-greenhouse' :
                                         'target-custom'

      leads.push(manualReviewPlaceholder(
        target.name, careerUrl,
        `Scrape failed: ${msg}. Visit ${careerUrl} directly.`,
        src, target.lane, 'error',
      ))
    }
  }

  return { leads, errors }
}
