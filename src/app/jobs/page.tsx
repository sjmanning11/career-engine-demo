'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { LANE_LABELS, SHORTLIST_SCORE_THRESHOLD, MANUAL_CHECKLIST, type Lane } from '@/lib/targeting'

interface Job {
  id: number
  title: string
  company: string
  location: string | null
  salary_display: string | null
  url: string
  fit_score: number
  fit_label: string
  fit_summary: string
  date_found: string
  status: string
  description: string
  lane: Lane | null
}

interface CuratedLead {
  id: number
  external_id: string
  title: string
  company: string
  location: string | null
  url: string
  fit_score: number | null
  fit_label: string | null
  fit_summary: string | null
  date_found: string
  status: string
  source: string
  description: string | null
  location_unverified: boolean | null
  requires_manual_review: boolean | null
  lane: Lane | null
}

// Lane badge colors — active lanes are amber-family; the exploratory CJ vendor
// lane is visually distinct (violet) because it is surfaced separately.
const LANE_BADGE_STYLES: Record<Lane, { bg: string; border: string; color: string }> = {
  'analytics-data': { bg: 'rgba(56,189,248,0.1)',  border: 'rgba(56,189,248,0.3)',  color: '#38bdf8' },
  'fpa':            { bg: 'rgba(74,222,128,0.1)',  border: 'rgba(74,222,128,0.3)',  color: '#4ade80' },
  'aec-ic':         { bg: 'rgba(200,132,58,0.1)',  border: 'rgba(200,132,58,0.3)',  color: '#C8843A' },
  'cj-vendor':      { bg: 'rgba(167,139,250,0.1)', border: 'rgba(167,139,250,0.3)', color: '#a78bfa' },
}

function LaneBadge({ lane }: { lane: Lane | null }) {
  if (!lane || !LANE_BADGE_STYLES[lane]) return null
  const s = LANE_BADGE_STYLES[lane]
  return (
    <span style={{
      fontSize: '10px',
      fontFamily: 'IBM Plex Mono, monospace',
      background: s.bg,
      border: `1px solid ${s.border}`,
      color: s.color,
      borderRadius: '4px',
      padding: '2px 8px',
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
    }}>
      {LANE_LABELS[lane]}
    </span>
  )
}

// Manual verification checklist — shown on shortlisted opportunities only.
// Deliberately a human checklist item, never inferred from title/posting text.
function ManualChecklist({ score }: { score: number | null }) {
  if (score == null || score < SHORTLIST_SCORE_THRESHOLD) return null
  return (
    <div style={{
      marginTop: '10px',
      padding: '8px 12px',
      background: 'rgba(250,204,21,0.05)',
      border: '1px solid rgba(250,204,21,0.15)',
      borderRadius: '6px',
    }}>
      <div style={{
        fontSize: '9px',
        fontFamily: 'IBM Plex Mono, monospace',
        color: '#4A4846',
        letterSpacing: '0.08em',
        marginBottom: '4px',
      }}>
        MANUAL VERIFICATION — SHORTLIST
      </div>
      {MANUAL_CHECKLIST.map(item => (
        <label key={item} style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '12px',
          color: '#facc15',
          cursor: 'pointer',
        }}>
          <input type="checkbox" style={{ accentColor: '#facc15' }} />
          {item}
        </label>
      ))}
    </div>
  )
}

export default function JobsPage() {
  const [token, setToken] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [authenticated, setAuthenticated] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [curatedLeads, setCuratedLeads] = useState<CuratedLead[]>([])
  const [curatedLoading, setCuratedLoading] = useState(false)
  const [curatedError, setCuratedError] = useState('')
  const [curatedRefreshing, setCuratedRefreshing] = useState(false)
  const router = useRouter()

  useEffect(() => {
    const stored = sessionStorage.getItem('career_live_token')
    if (stored) {
      setToken(stored)
      setAuthenticated(true)
    }
  }, [])

  useEffect(() => {
    if (authenticated && token) {
      fetchJobs()
      fetchCuratedLeads()
    }
  }, [authenticated, token])

  async function handleAuth() {
    setLoading(true)
    try {
      const res = await fetch('/api/jobs', {
        headers: { 'X-Live-Token': tokenInput }
      })
      if (res.status === 401) {
        setError('Incorrect password')
        setLoading(false)
        return
      }
      const data = await res.json()
      sessionStorage.setItem('career_live_token', tokenInput)
      setToken(tokenInput)
      setJobs(data.jobs || [])
      setAuthenticated(true)
    } catch {
      setError('Connection failed')
    } finally {
      setLoading(false)
    }
  }

  async function fetchJobs() {
    setLoading(true)
    try {
      const res = await fetch('/api/jobs', {
        headers: { 'X-Live-Token': token }
      })
      const data = await res.json()
      setJobs(data.jobs || [])
    } catch {
      setError('Failed to load jobs')
    } finally {
      setLoading(false)
    }
  }

  async function fetchCuratedLeads() {
    setCuratedLoading(true)
    setCuratedError('')
    try {
      const res = await fetch('/api/job-leads', {
        headers: { 'X-Live-Token': token }
      })
      const data = await res.json() as { leads?: CuratedLead[] }
      setCuratedLeads(data.leads || [])
    } catch {
      setCuratedError('Failed to load curated leads')
    } finally {
      setCuratedLoading(false)
    }
  }

  async function refreshCuratedLeads() {
    setCuratedRefreshing(true)
    setCuratedError('')
    try {
      const res = await fetch('/api/job-leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Live-Token': token,
        },
        body: JSON.stringify({ refresh: true }),
      })
      const data = await res.json() as { scraped?: number; stored?: number; scored?: number; errors?: string[] }
      if (!res.ok) {
        setCuratedError(`Refresh failed: ${JSON.stringify(data)}`)
      } else {
        await fetchCuratedLeads()
      }
    } catch {
      setCuratedError('Refresh request failed')
    } finally {
      setCuratedRefreshing(false)
    }
  }

  async function updateStatus(id: number, status: string) {
    await fetch('/api/jobs', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Live-Token': token,
      },
      body: JSON.stringify({ id, status }),
    })
    setJobs(jobs.map(j => j.id === id ? { ...j, status } : j))
  }

  function analyze(job: Job) {
    sessionStorage.setItem('career_prefill_job', job.description)
    sessionStorage.setItem('career_prefill_title', `${job.title} at ${job.company}`)
    router.push('/')
  }

  const pageStyle: React.CSSProperties = {
    minHeight: '100vh',
    background: '#0F0F0F',
    color: '#F0EDE8',
    fontFamily: 'system-ui, sans-serif',
    padding: '0',
  }

  const headerStyle: React.CSSProperties = {
    borderBottom: '1px solid rgba(240,237,232,0.07)',
    padding: '20px 40px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  }

  const containerStyle: React.CSSProperties = {
    maxWidth: '900px',
    margin: '0 auto',
    padding: '40px 24px',
  }

  const cardStyle = (status: string): React.CSSProperties => ({
    background: status === 'applied' ? 'rgba(74,222,128,0.05)'
      : status === 'passed' ? 'rgba(255,255,255,0.02)'
      : '#1A1A1A',
    border: `1px solid ${
      status === 'applied' ? 'rgba(74,222,128,0.2)'
      : status === 'passed' ? 'rgba(240,237,232,0.04)'
      : 'rgba(240,237,232,0.08)'
    }`,
    borderRadius: '12px',
    padding: '24px',
    marginBottom: '16px',
    opacity: status === 'passed' ? 0.5 : 1,
  })

  const scoreColor = (score: number) =>
    score >= 95 ? '#4ade80'
    : score >= 90 ? '#C8843A'
    : '#8A8784'

  if (!authenticated) {
    return (
      <div style={pageStyle}>
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{
            background: '#1A1A1A',
            border: '1px solid rgba(240,237,232,0.08)',
            borderRadius: '12px',
            padding: '40px',
            width: '340px',
          }}>
            <div style={{
              fontSize: '11px',
              fontFamily: 'IBM Plex Mono, monospace',
              color: '#C8843A',
              letterSpacing: '0.1em',
              marginBottom: '24px',
            }}>
              JOB LEADS
            </div>
            <input
              type="password"
              value={tokenInput}
              onChange={e => {
                setTokenInput(e.target.value)
                setError('')
              }}
              onKeyDown={e => e.key === 'Enter' && handleAuth()}
              placeholder="Enter password"
              autoFocus
              style={{
                width: '100%',
                background: '#0F0F0F',
                border: `1px solid ${error ? '#ef4444' : 'rgba(240,237,232,0.1)'}`,
                borderRadius: '8px',
                padding: '12px',
                color: '#F0EDE8',
                fontSize: '14px',
                marginBottom: '8px',
                boxSizing: 'border-box',
                outline: 'none',
              }}
            />
            {error && (
              <div style={{
                fontSize: '12px',
                color: '#ef4444',
                marginBottom: '12px',
                fontFamily: 'IBM Plex Mono, monospace',
              }}>
                {error}
              </div>
            )}
            <button
              onClick={handleAuth}
              disabled={loading}
              style={{
                width: '100%',
                background: '#C8843A',
                border: 'none',
                borderRadius: '8px',
                padding: '12px',
                color: '#0F0F0F',
                fontSize: '14px',
                fontWeight: '500',
                cursor: loading ? 'not-allowed' : 'pointer',
                marginTop: '4px',
              }}
            >
              {loading ? 'Checking...' : 'Enter'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const newJobs = jobs.filter(j => j.status === 'new')
  const appliedJobs = jobs.filter(j => j.status === 'applied')
  const passedJobs = jobs.filter(j => j.status === 'passed')

  const MIN_SCORE = 50
  // CJ vendor lane is exploratory — surfaced in its own section, never blended
  // into the primary Analytics/Data > FP&A > AEC-IC lists.
  const scoredCuratedLeads = curatedLeads.filter(l => l.fit_score != null && l.fit_score >= MIN_SCORE)
  const visibleCuratedLeads = scoredCuratedLeads.filter(l => l.lane !== 'cj-vendor')
  const cjVendorLeads = scoredCuratedLeads.filter(l => l.lane === 'cj-vendor')
  const visibleJobs = [...newJobs, ...appliedJobs, ...passedJobs].filter(j => j.fit_score >= MIN_SCORE && j.lane !== 'cj-vendor')
  const cjVendorJobs = [...newJobs, ...appliedJobs, ...passedJobs].filter(j => j.fit_score >= MIN_SCORE && j.lane === 'cj-vendor')

  const renderCuratedLead = (lead: CuratedLead) => (
        <div key={lead.external_id} style={{
          background: '#1A1A1A',
          border: '1px solid rgba(240,237,232,0.08)',
          borderRadius: '10px',
          padding: '18px 22px',
          marginBottom: '10px',
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '16px',
            marginBottom: '8px',
          }}>
            <div style={{ flex: 1 }}>
              <div style={{
                fontSize: '15px',
                fontWeight: '500',
                color: '#F0EDE8',
                marginBottom: '3px',
              }}>
                {lead.title}
              </div>
              <div style={{ fontSize: '13px', color: '#8A8784' }}>
                {lead.company}
                {lead.location ? ` · ${lead.location}` : ''}
              </div>
            </div>
            {lead.fit_score != null && (
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{
                  fontSize: '22px',
                  fontWeight: '600',
                  color: lead.fit_score >= 85 ? '#4ade80' : lead.fit_score >= 65 ? '#C8843A' : '#8A8784',
                  fontFamily: 'IBM Plex Mono, monospace',
                  lineHeight: 1,
                }}>
                  {lead.fit_score}
                </div>
                <div style={{
                  fontSize: '9px',
                  color: '#4A4846',
                  fontFamily: 'IBM Plex Mono, monospace',
                  marginTop: '2px',
                }}>
                  FIT SCORE
                </div>
              </div>
            )}
          </div>

          {/* Badges */}
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <LaneBadge lane={lead.lane} />
            {(lead.location?.toLowerCase().includes('remote') || lead.source === 'target-ashby' && !lead.location_unverified) && (
              <span style={{
                fontSize: '10px',
                fontFamily: 'IBM Plex Mono, monospace',
                background: 'rgba(74,222,128,0.1)',
                border: '1px solid rgba(74,222,128,0.25)',
                color: '#4ade80',
                borderRadius: '4px',
                padding: '2px 8px',
                letterSpacing: '0.06em',
              }}>
                REMOTE
              </span>
            )}
            {lead.location_unverified && (
              <span style={{
                fontSize: '10px',
                fontFamily: 'IBM Plex Mono, monospace',
                background: 'rgba(250,204,21,0.1)',
                border: '1px solid rgba(250,204,21,0.25)',
                color: '#facc15',
                borderRadius: '4px',
                padding: '2px 8px',
                letterSpacing: '0.06em',
              }}>
                VERIFY LOCATION
              </span>
            )}
            {lead.requires_manual_review && (
              <span style={{
                fontSize: '10px',
                fontFamily: 'IBM Plex Mono, monospace',
                background: 'rgba(138,135,132,0.1)',
                border: '1px solid rgba(138,135,132,0.2)',
                color: '#8A8784',
                borderRadius: '4px',
                padding: '2px 8px',
                letterSpacing: '0.06em',
              }}>
                CHECK MANUALLY
              </span>
            )}
          </div>

          {lead.fit_summary && !lead.requires_manual_review && (
            <div style={{
              fontSize: '12px',
              color: '#8A8784',
              lineHeight: '1.5',
              marginBottom: '10px',
            }}>
              {lead.fit_summary}
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px' }}>
            <a
              href={lead.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: '#C8843A',
                border: 'none',
                borderRadius: '6px',
                color: '#0F0F0F',
                fontSize: '12px',
                fontWeight: '500',
                padding: '7px 14px',
                textDecoration: 'none',
                fontFamily: 'IBM Plex Mono, monospace',
              }}
            >
              View posting ↗
            </a>
            {lead.description && !lead.requires_manual_review && (
              <button
                onClick={() => {
                  sessionStorage.setItem('career_prefill_job', lead.description ?? '')
                  sessionStorage.setItem('career_prefill_title', `${lead.title} at ${lead.company}`)
                  router.push('/')
                }}
                style={{
                  background: 'none',
                  border: '1px solid rgba(240,237,232,0.1)',
                  borderRadius: '6px',
                  color: '#8A8784',
                  fontSize: '12px',
                  padding: '7px 14px',
                  cursor: 'pointer',
                  fontFamily: 'IBM Plex Mono, monospace',
                }}
              >
                Analyze →
              </button>
            )}
          </div>
          <ManualChecklist score={lead.fit_score} />
        </div>
  )

  const renderGeneralJob = (job: Job) => (
      <div key={job.id} style={cardStyle(job.status)}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '12px',
          gap: '16px',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: '16px',
              fontWeight: '500',
              color: '#F0EDE8',
              marginBottom: '4px',
            }}>
              {job.title}
            </div>
            <div style={{
              fontSize: '13px',
              color: '#8A8784',
            }}>
              {job.company}
              {job.location ? ` · ${job.location}` : ''}
              {job.salary_display
                ? ` · ${job.salary_display}`
                : ' · Salary not listed'}
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
              <LaneBadge lane={job.lane} />
            </div>
          </div>
          <div style={{
            textAlign: 'right',
            flexShrink: 0,
          }}>
            <div style={{
              fontSize: '24px',
              fontWeight: '600',
              color: scoreColor(job.fit_score),
              fontFamily: 'IBM Plex Mono, monospace',
              lineHeight: 1,
            }}>
              {job.fit_score}
            </div>
            <div style={{
              fontSize: '10px',
              color: '#4A4846',
              fontFamily: 'IBM Plex Mono, monospace',
              marginTop: '2px',
            }}>
              FIT SCORE
            </div>
            <ManualChecklist score={job.fit_score} />
          </div>
        </div>

        <div style={{
          fontSize: '13px',
          color: '#8A8784',
          lineHeight: '1.6',
          marginBottom: '16px',
        }}>
          {job.fit_summary}
        </div>

        <div style={{
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}>
          <button
            onClick={() => analyze(job)}
            style={{
              background: '#C8843A',
              border: 'none',
              borderRadius: '6px',
              color: '#0F0F0F',
              fontSize: '12px',
              fontWeight: '500',
              padding: '8px 16px',
              cursor: 'pointer',
              fontFamily: 'IBM Plex Mono, monospace',
            }}
          >
            Analyze →
          </button>
          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              background: 'none',
              border: '1px solid rgba(240,237,232,0.1)',
              borderRadius: '6px',
              color: '#8A8784',
              fontSize: '12px',
              padding: '8px 16px',
              cursor: 'pointer',
              textDecoration: 'none',
              fontFamily: 'IBM Plex Mono, monospace',
            }}
          >
            View posting ↗
          </a>
          {job.status === 'new' && (
            <>
              <button
                onClick={() => updateStatus(job.id, 'applied')}
                style={{
                  background: 'none',
                  border: '1px solid rgba(74,222,128,0.2)',
                  borderRadius: '6px',
                  color: '#4ade80',
                  fontSize: '12px',
                  padding: '8px 16px',
                  cursor: 'pointer',
                  fontFamily: 'IBM Plex Mono, monospace',
                }}
              >
                Mark applied
              </button>
              <button
                onClick={() => updateStatus(job.id, 'passed')}
                style={{
                  background: 'none',
                  border: '1px solid rgba(240,237,232,0.07)',
                  borderRadius: '6px',
                  color: '#4A4846',
                  fontSize: '12px',
                  padding: '8px 16px',
                  cursor: 'pointer',
                  fontFamily: 'IBM Plex Mono, monospace',
                }}
              >
                Pass
              </button>
            </>
          )}
          {job.status === 'applied' && (
            <span style={{
              fontSize: '11px',
              color: '#4ade80',
              fontFamily: 'IBM Plex Mono, monospace',
              letterSpacing: '0.08em',
            }}>
              APPLIED
            </span>
          )}
        </div>
      </div>
  )

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <div style={{
          fontSize: '11px',
          fontFamily: 'IBM Plex Mono, monospace',
          color: '#C8843A',
          letterSpacing: '0.1em',
        }}>
          JOB LEADS
        </div>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', color: '#4A4846' }}>
            {newJobs.length} new · {appliedJobs.length} applied · {passedJobs.length} passed
          </span>
          <button
            onClick={fetchJobs}
            style={{
              background: 'none',
              border: '1px solid rgba(240,237,232,0.1)',
              borderRadius: '6px',
              color: '#8A8784',
              fontSize: '12px',
              padding: '6px 12px',
              cursor: 'pointer',
              fontFamily: 'IBM Plex Mono, monospace',
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      <div style={containerStyle}>
        {loading && (
          <div style={{
            textAlign: 'center',
            color: '#4A4846',
            padding: '60px',
            fontFamily: 'IBM Plex Mono, monospace',
            fontSize: '12px',
          }}>
            Loading job leads...
          </div>
        )}

        {!loading && jobs.length === 0 && (
          <div style={{
            textAlign: 'center',
            color: '#4A4846',
            padding: '60px',
          }}>
            <div style={{
              fontFamily: 'IBM Plex Mono, monospace',
              fontSize: '12px',
              marginBottom: '8px',
            }}>
              No job leads yet
            </div>
            <div style={{ fontSize: '13px' }}>
              The daily scan runs at 8am CT. Check back tomorrow.
            </div>
          </div>
        )}

        {/* ── Curated Company Targets ────────────────────────────────── */}
        <div style={{
          borderBottom: '1px solid rgba(240,237,232,0.07)',
          paddingBottom: '24px',
          marginBottom: '32px',
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '16px',
          }}>
            <div>
              <div style={{
                fontSize: '11px',
                fontFamily: 'IBM Plex Mono, monospace',
                color: '#C8843A',
                letterSpacing: '0.1em',
                marginBottom: '2px',
              }}>
                CURATED COMPANY TARGETS · ANALYTICS/DATA &gt; FP&amp;A &gt; AEC-IC
              </div>
              <div style={{ fontSize: '12px', color: '#4A4846' }}>
                {visibleCuratedLeads.length} lead{visibleCuratedLeads.length !== 1 ? 's' : ''} scored ≥50 · {curatedLeads.filter(l => l.requires_manual_review).length} require manual review
              </div>
            </div>
            <button
              onClick={refreshCuratedLeads}
              disabled={curatedRefreshing}
              style={{
                background: curatedRefreshing ? 'rgba(200,132,58,0.2)' : 'none',
                border: '1px solid rgba(200,132,58,0.3)',
                borderRadius: '6px',
                color: '#C8843A',
                fontSize: '12px',
                padding: '6px 14px',
                cursor: curatedRefreshing ? 'not-allowed' : 'pointer',
                fontFamily: 'IBM Plex Mono, monospace',
              }}
            >
              {curatedRefreshing ? 'Scraping…' : 'Refresh Curated Leads'}
            </button>
          </div>

          {curatedError && (
            <div style={{
              fontSize: '12px',
              color: '#ef4444',
              fontFamily: 'IBM Plex Mono, monospace',
              marginBottom: '12px',
            }}>
              {curatedError}
            </div>
          )}

          {curatedLoading && (
            <div style={{
              color: '#4A4846',
              fontSize: '12px',
              fontFamily: 'IBM Plex Mono, monospace',
            }}>
              Loading curated leads…
            </div>
          )}

          {!curatedLoading && curatedLeads.length === 0 && (
            <div style={{
              color: '#4A4846',
              fontSize: '13px',
            }}>
              No curated leads yet. Click &ldquo;Refresh Curated Leads&rdquo; to run the first scrape.
            </div>
          )}

          {!curatedLoading && curatedLeads.length > 0 && visibleCuratedLeads.length === 0 && (
            <div style={{
              color: '#4A4846',
              fontSize: '13px',
              fontFamily: 'IBM Plex Mono, monospace',
            }}>
              No leads above the score threshold yet. Check back after the next refresh.
            </div>
          )}

          {visibleCuratedLeads.map(renderCuratedLead)}
        </div>

        {/* ── CJ Vendor lane (exploratory — separate from primary lanes) ── */}
        {(cjVendorLeads.length > 0 || cjVendorJobs.length > 0) && (
          <div style={{
            borderBottom: '1px solid rgba(167,139,250,0.15)',
            paddingBottom: '24px',
            marginBottom: '32px',
          }}>
            <div style={{
              fontSize: '11px',
              fontFamily: 'IBM Plex Mono, monospace',
              color: '#a78bfa',
              letterSpacing: '0.1em',
              marginBottom: '2px',
            }}>
              CJ VENDOR LANE — EXPLORATORY
            </div>
            <div style={{ fontSize: '12px', color: '#4A4846', marginBottom: '16px' }}>
              Criminal-justice vendors (Tyler Technologies, Axon, LexisNexis Risk, Recidiviz) · tracked separately, not blended into primary lanes
            </div>
            {cjVendorLeads.map(renderCuratedLead)}
            {cjVendorJobs.map(job => renderGeneralJob(job))}
          </div>
        )}


        {/* ── General job leads (all sources) ────────────────────────── */}
        <div style={{
          fontSize: '11px',
          fontFamily: 'IBM Plex Mono, monospace',
          color: '#4A4846',
          letterSpacing: '0.08em',
          marginBottom: '20px',
        }}>
          ALL LEADS · {visibleJobs.filter(j => j.status === 'new').length} new · score ≥50
        </div>

        {visibleJobs.length === 0 && !loading && (
          <div style={{
            color: '#4A4846',
            fontSize: '13px',
            fontFamily: 'IBM Plex Mono, monospace',
            padding: '24px 0',
          }}>
            No leads above the score threshold yet. Check back after the next refresh.
          </div>
        )}

        {visibleJobs.map(job => renderGeneralJob(job))}
      </div>
    </div>
  )
}
