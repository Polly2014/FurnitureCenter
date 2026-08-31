export interface Env {
  DB: D1Database
  IMAGES: R2Bucket
  ASSETS: Fetcher
  COPILOTX_API_KEY: string
  SESSION_SIGNING_KEY: string
  ENVIRONMENT: 'local' | 'preview' | 'production'
}
