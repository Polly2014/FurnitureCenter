import type { QueryResult } from '../catalog/models'
const DEFAULT_BASE_URL = 'https://api.polly.wang/v1'
const DEFAULT_MODEL = 'gpt-5.6-terra'

export class CopilotXError extends Error {}
export class CopilotXAbortError extends Error {}

type CopilotXOptions = {
  apiKey: string
  baseUrl?: string
  model?: string
  fetch?: typeof globalThis.fetch
}

function endpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/$/u, '')}/responses`
}

async function responseJson(response: Response) {
  if (!response.ok) throw new CopilotXError('CopilotX request failed')
  try {
    return await response.json() as { output_text?: unknown }
  } catch {
    throw new CopilotXError('CopilotX returned invalid JSON')
  }
}

function responseText(payload: { output_text?: unknown }) {
  if (typeof payload.output_text !== 'string' || !payload.output_text.trim()) {
    throw new CopilotXError('CopilotX returned an empty response')
  }
  return payload.output_text
}

export class CopilotXClient {
  private readonly fetcher: typeof globalThis.fetch
  private readonly baseUrl: string
  private readonly model: string

  constructor(private readonly options: CopilotXOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.model = options.model ?? DEFAULT_MODEL
  }

  async plan(
    message: string,
    categories: string[],
    sites: Array<{ id: string; name: string; city: string }>,
    signal?: AbortSignal,
  ) {
    try {
      const response = await this.fetcher(endpoint(this.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          instructions: '你是家具目录查询规划器。只返回 JSON：query、category、site_id、available_only。只能使用给定分类与站点 ID；无法确定时用 null；available_only 必须是布尔值。',
          input: JSON.stringify({ message, categories, sites }),
        }),
        signal,
      })
      return JSON.parse(responseText(await responseJson(response))) as unknown
    } catch (error) {
      if (signal?.aborted) throw new CopilotXAbortError('planning cancelled')
      if (error instanceof CopilotXError) throw error
      throw new CopilotXError('CopilotX planning failed')
    }
  }

  async streamAnswer(
    message: string,
    result: QueryResult,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
  ) {
    const items = result.items.slice(0, 20).map((item) => ({
      name: item.name,
      name_en: item.name_en,
      category: item.category,
      brand: item.brand,
      dimensions: item.dimensions,
      color: item.color,
      material: item.material,
      quantity_available: item.quantity_available,
      sites: item.inventory.map((position) => position.site.name),
    }))
    let response: Response
    try {
      response = await this.fetcher(endpoint(this.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          instructions: '你是 FurnitureCenter 家具查询助手。仅根据提供的真实查询结果，用简洁自然的中文回答。不得编造家具、地点、库存或属性。不要描述内部查询过程，不要使用 Markdown 表格。',
          input: JSON.stringify({ question: message, total_kinds: result.total, items }),
        }),
        signal,
      })
    } catch {
      throw new CopilotXError('CopilotX answer stream failed')
    }
    if (!response.ok || !response.body) throw new CopilotXError('CopilotX answer stream failed')
    if (signal?.aborted) throw new CopilotXAbortError('answer stream cancelled')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let completed = false
    const handle = (block: string) => {
      let event = 'message'
      const dataLines: string[] = []
      for (const line of block.split(/\r?\n/u)) {
        if (!line || line.startsWith(':')) continue
        const separator = line.indexOf(':')
        const field = separator === -1 ? line : line.slice(0, separator)
        const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /u, '')
        if (field === 'event') event = value
        if (field === 'data') dataLines.push(value)
      }
      if (event === 'error' || event === 'response.failed' || event === 'response.incomplete' || event === 'response.cancelled') {
        throw new CopilotXError('CopilotX answer stream failed')
      }
      if (dataLines.length === 0) return
      try {
        const payload = JSON.parse(dataLines.join('\n')) as { delta?: unknown }
        if (event === 'response.output_text.delta' && typeof payload.delta === 'string' && payload.delta && !signal?.aborted) {
          onDelta(payload.delta)
        }
        if (event === 'response.completed') completed = true
      } catch {
        throw new CopilotXError('CopilotX answer stream is invalid')
      }
    }
    const cancelReader = () => { void reader.cancel('downstream cancelled') }
    signal?.addEventListener('abort', cancelReader, { once: true })
    try {
      while (true) {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        let boundary = buffer.match(/\r?\n\r?\n/u)
        while (boundary?.index !== undefined) {
          handle(buffer.slice(0, boundary.index))
          buffer = buffer.slice(boundary.index + boundary[0].length)
          boundary = buffer.match(/\r?\n\r?\n/u)
        }
        if (done) break
      }
      if (buffer.trim()) handle(buffer)
      if (signal?.aborted) throw new CopilotXAbortError('answer stream cancelled')
      if (!completed) throw new CopilotXError('CopilotX answer stream ended without completion')
    } catch (error) {
      if (signal?.aborted) throw new CopilotXAbortError('answer stream cancelled')
      if (error instanceof CopilotXError) throw error
      throw new CopilotXError('CopilotX answer stream failed')
    } finally {
      signal?.removeEventListener('abort', cancelReader)
    }
  }
}

export { DEFAULT_BASE_URL, DEFAULT_MODEL }
