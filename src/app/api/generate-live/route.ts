export const maxDuration = 300
export const dynamic = 'force-dynamic'

import Anthropic from '@anthropic-ai/sdk'
import { DNA_PROMPT } from '@/lib/dna'
import { locationPrecheck, LOCATION_GATE_PROMPT_BLOCK } from '@/lib/locationGate'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: 'API key not configured' }, { status: 503 })
  }

  const token = request.headers.get('X-Live-Token')
  if (token !== process.env.LIVE_MODE_TOKEN) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { jobPosting } = await request.json()
  if (!jobPosting?.trim()) {
    return Response.json({ error: 'No job posting provided' }, { status: 400 })
  }

  // generate-live receives one raw pasted blob, not structured location fields.
  // Pass an empty location so the blob is evaluated as description text only:
  // this preserves the precheck's precedence rule (explicit on-site language
  // beats an incidental "remote" mention). Passing the blob as the location
  // argument would let "no remote" match the remote-location regex first.
  // Worst case is UNCLEAR, which the gate handles safely (manual review, not
  // exclusion).
  const precheck = locationPrecheck('', jobPosting)

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: DNA_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Analyze this job posting for Sam Manning and produce a complete career package.

SCORING INSTRUCTIONS — apply these before generating any output:

${LOCATION_GATE_PROMPT_BLOCK}

OUTPUT ADAPTATION for this task: where the gate above says to output {"score": 0, "label": ..., "summary": ...} and stop, instead set roleFit.score to 0, roleFit.scoreLabel to "Excluded - relocation required", and roleFit.summary to "Role requires relocation outside Austin TX commute area. Hard filter applied." Still generate the full JSON structure but reflect the disqualification throughout. Do not alter the gate rules themselves.

STEP 2 — Only if the role passed Step 1, score it 0-100 using the rubric defined
in your system instructions.

ENVIRONMENT FIT INSTRUCTIONS — apply these when populating roleFit.strengths and roleFit.gaps:
- Factor in environment fit alongside skills match
- If the job description signals command-and-control leadership, advisory-only
  authority, or large bureaucratic culture, note this explicitly in gaps with
  severity "major"
- If the company signals builder culture, early stage, genuine collaboration,
  and execution authority, note this as a strength
- Sam's burnout came from building systems for a leader who would not implement
  them. A skills match without environment fit is not a strong match. Always
  assess both.

CRITICAL RESUME RULES — apply these when generating the resume object:
- Maximum 2 pages when rendered as a Word document
- Use exact dates: Partner 2020-2025, Project Architect 2014-2020, Project Manager
  2011-2014, Project Designer 2010-2011 (only if fits)
- Use exact contact: sjmanning@gmail.com, 360-261-1531, linkedin.com/in/sjmanningtx,
  Austin TX
- Include FMVA certification in education:
  "M.Arch + B.S. Architecture, Washington State University | FMVA (CFI, April 2026)"
- Include the 16x expansion ($80K to $1.3M+) and $75M+ numbers in Partner role bullets
- Include the deal preservation story ($35M to $69M restructured to $40M, preserved
  $1.6M) if space permits
- If content does not fit 2 pages, cut Project Designer first, then abbreviate
  Project Manager, never cut the numbers
- Location is always Austin TX, never Georgetown TX
- Do NOT include a separate "AI Systems Developer" or "Tano Architecture" experience
  entry. All AI and systems-building work should be woven into bullets within the
  Clayton Korte Partner role (2020-2025) where relevant.
- Company name is always "Clayton Korte" for all experience entries. Never use
  "Tano Architecture" or "Tano Studio".
- Never use em dashes (—) anywhere in the resume or cover letter. Use commas,
  colons, or rewrite the sentence instead.
- Never mention BizBox in any output. If referencing self-built applications,
  use TanoBox or tanobuild.com only.
- Never include product names (TanoBox, BizBox, SATS, APEX, tanobuild.com) in the
  skills array. Skills must be capabilities only, not product names.
- Never reference SATS or the trading system by its name in resume bullets. Describe
  it as "autonomous multi-agent AI system" or "13-container Docker AI stack" without
  naming it.
- Every experience entry MUST include an "intro" field: a single sentence (under 30
  words) describing the overall scope of the role, placed before the bullets. For
  the Partner 2020-2025 entry, describe the de facto CRO and operational architect
  scope. For Project Architect and Project Manager, describe the project delivery scope.

OUTPUT REQUIREMENTS:
- Include 3-5 strengths, 1-3 gaps, 4-6 talking points, 3-5 negotiation notes,
  2-4 red flags
- Be specific to Sam's actual background — no generic advice
- Return only valid JSON. No markdown fences, no preamble, no explanation.

LOCATION PRE-CHECK: ${precheck}

JOB POSTING:
${jobPosting}

Return a JSON object with EXACTLY this structure — match every field name and type
precisely. No text before or after the JSON object.

{
  "roleFit": {
    "score": <integer 0-100>,
    "scoreLabel": "<one of: Poor match | Partial match | Good match | Strong match | Exceptional match>",
    "summary": "<2-3 sentences assessing overall fit>",
    "strengths": [
      {
        "title": "<strength title>",
        "detail": "<2-3 sentence explanation specific to Sam's background>"
      }
    ],
    "gaps": [
      {
        "title": "<gap title>",
        "detail": "<2-3 sentence explanation with framing advice>",
        "severity": "<one of: minor | moderate | major>"
      }
    ]
  },
  "talkingPoints": [
    {
      "question": "<likely interview question>",
      "approach": "<how to answer it using Sam's specific background>",
      "keyMessage": "<the one sentence that must land>"
    }
  ],
  "salaryBrief": {
    "postedRange": "<salary range as posted in the job description, or 'Not specified' if absent>",
    "marketContext": "<2-3 sentences on market rates for this role, level, and location>",
    "recommendation": "<specific target number and negotiation position>",
    "negotiationNotes": [
      "<specific negotiation tactic or data point>"
    ],
    "redFlags": [
      "<compensation red flag to watch for>"
    ]
  },
  "resume": {
    "targetTitle": "<role-specific professional title for this job, e.g. 'Director of Revenue Operations' or 'VP of Go-To-Market'>",
    "summary": "<2-3 sentence professional summary tailored to this specific role>",
    "experience": [
      {
        "company": "<company name>",
        "title": "<job title>",
        "dates": "<date range>",
        "intro": "<single sentence under 30 words describing the overall scope of the role>",
        "bullets": [
          "<achievement bullet — specific, quantified where possible>",
          "<achievement bullet>",
          "<achievement bullet>"
        ]
      }
    ],
    "skills": ["<skill 1>", "<skill 2>", "<skill 3>"],
    "education": "<degree and institution>"
  },
  "coverLetter": {
    "opening": "<first paragraph — specific hook connecting Sam to this company and role>",
    "body": "<second paragraph — two strongest matching credentials with specific evidence>",
    "close": "<third paragraph — forward-looking close, confident, no filler>"
  }
}`,
        },
      ],
    })

    const content = message.content[0]
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude API')
    }

    // Robust JSON extraction: strip any preamble/postamble and markdown fences,
    // then find the outermost JSON object using brace matching.
    // This handles cases where Claude adds explanation text before or after the JSON.
    const rawText = content.text.trim()

    let jsonString: string | null = null

    // First pass: try stripping markdown fences if present
    const fenceStripped = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()

    // Second pass: find the outermost { ... } block to handle any preamble/postamble
    const firstBrace = fenceStripped.indexOf('{')
    const lastBrace = fenceStripped.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonString = fenceStripped.slice(firstBrace, lastBrace + 1)
    } else {
      jsonString = fenceStripped
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(jsonString)
    } catch (parseError) {
      console.error('generate-live JSON parse failed. Raw response length:', rawText.length)
      console.error('generate-live JSON parse failed. First 500 chars:', rawText.slice(0, 500))
      throw new Error(`JSON parse failed: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
    }

    return Response.json({
      success: true,
      data: parsed,
      demo: false,
    })
  } catch (error) {
    console.error('generate-live error:', error)
    return Response.json(
      {
        error: 'Generation failed',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
