import type { APIRoute } from 'astro'
import { marketplaceDownloads } from '../../../marketplace.ts'

export async function getStaticPaths() {
  return (await marketplaceDownloads()).map(({ artifact, body }) => ({ params: { artifact }, props: { body } }))
}
export const GET: APIRoute = ({ props }) => new Response(props.body, { headers: { 'Content-Type': 'application/json' } })
