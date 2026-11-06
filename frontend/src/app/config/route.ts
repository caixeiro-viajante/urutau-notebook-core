import { NextResponse } from 'next/server'

/**
 * Browser API requests use the same origin as the frontend by default.
 * Next.js rewrites /api/* to INTERNAL_API_URL on the server, so an HTTPS
 * page never sends credentials to an auto-detected HTTP endpoint.
 * API_URL remains available for deployments with an explicit public API URL.
 */
export async function GET() {
  const envApiUrl = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL

  return NextResponse.json(
    { apiUrl: envApiUrl || '' },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
