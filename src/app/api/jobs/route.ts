import { NextRequest } from 'next/server'
import { getDb, initDb } from '@/lib/db'

export const maxDuration = 300

export async function GET(request: NextRequest) {
  const token = request.headers.get('X-Live-Token')
  if (token !== process.env.LIVE_MODE_TOKEN) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await initDb()
  const sql = getDb()

  // Historical rows are preserved in the table, but excluded companies are
  // never surfaced (Clayton Korte under any title; Clayco direct-employee
  // conversions).
  const jobs = await sql`
    SELECT
      id, title, company, location, salary_display,
      url, fit_score, fit_label, fit_summary,
      date_found, status, description, lane
    FROM job_leads
    WHERE company !~* '\\yclayton\\s*korte\\y'
      AND company !~* '\\yclayco\\y'
    ORDER BY fit_score DESC, date_found DESC
    LIMIT 100
  `

  return Response.json({ jobs })
}

export async function PATCH(request: NextRequest) {
  const token = request.headers.get('X-Live-Token')
  if (token !== process.env.LIVE_MODE_TOKEN) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id, status } = await request.json()
  const sql = getDb()

  await sql`
    UPDATE job_leads SET status = ${status} WHERE id = ${id}
  `

  return Response.json({ success: true })
}
