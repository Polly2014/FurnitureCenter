export interface Env {
  DB: D1Database
  IMAGES: R2Bucket
  /** Cloudflare Images transform binding; derivatives remain private in IMAGES. */
  IMAGES_TRANSFORM: ImagesBinding
  ASSETS: Fetcher
  COPILOTX_API_KEY: string
  SESSION_SIGNING_KEY: string
  /** Explicit comma-separated workers.dev hosts accepted by the preview MCP route. */
  MCP_ALLOWED_HOSTS?: string
  ENVIRONMENT: 'local' | 'preview' | 'production'
}
