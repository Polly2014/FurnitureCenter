import { ApplicationError } from '../catalog/models'
import { D1SiteRepository, type SaveSiteRecord } from './repository'

export type SaveSiteInput = {
  code: string
  name: string
  city: string
  latitude: number
  longitude: number
  isActive: boolean
}

export type UpdateSiteInput = Partial<SaveSiteInput> & {
  expectedVersion: number
}

export class SiteService {
  constructor(private readonly repository: D1SiteRepository) {}

  list() {
    return this.repository.list()
  }

  async create(input: SaveSiteInput, actor: string) {
    const record = this.validate(input)
    if (await this.repository.codeExists(record.code)) {
      throw new ApplicationError(409, `Site code already exists: ${record.code}`)
    }
    try {
      return await this.repository.create(record, actor)
    } catch {
      throw new ApplicationError(409, `Site code already exists: ${record.code}`)
    }
  }

  async update(id: string, input: UpdateSiteInput, actor: string) {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new ApplicationError(422, 'expected version must be a positive integer')
    }
    const current = await this.repository.get(id)
    if (!current) throw new ApplicationError(404, `Site not found: ${id}`)
    if (current.version !== input.expectedVersion) {
      throw new ApplicationError(409, 'site changed; refresh and retry')
    }
    const record = this.validate({
      code: input.code ?? current.code,
      name: input.name ?? current.name,
      city: input.city ?? current.city,
      latitude: input.latitude ?? current.latitude,
      longitude: input.longitude ?? current.longitude,
      isActive: input.isActive ?? current.is_active,
    })
    if (await this.repository.codeExists(record.code, id)) {
      throw new ApplicationError(409, `Site code already exists: ${record.code}`)
    }
    try {
      const updated = await this.repository.update(current, record, input.expectedVersion, actor)
      if (!updated) throw new ApplicationError(409, 'site changed; refresh and retry')
      return updated
    } catch (error) {
      if (error instanceof ApplicationError) throw error
      throw new ApplicationError(409, `Site code already exists: ${record.code}`)
    }
  }

  private validate(input: SaveSiteInput): SaveSiteRecord {
    const code = input.code.trim().toUpperCase()
    const name = input.name.trim()
    const city = input.city.trim()
    if (!code || code.length > 50) {
      throw new ApplicationError(422, 'site code is required and must not exceed 50 characters')
    }
    if (!name || name.length > 200) {
      throw new ApplicationError(422, 'site name is required and must not exceed 200 characters')
    }
    if (!city || city.length > 200) {
      throw new ApplicationError(422, 'site city is required and must not exceed 200 characters')
    }
    if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90) {
      throw new ApplicationError(422, 'latitude must be between -90 and 90')
    }
    if (!Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) {
      throw new ApplicationError(422, 'longitude must be between -180 and 180')
    }
    return {
      code,
      name,
      city,
      latitude: input.latitude,
      longitude: input.longitude,
      isActive: input.isActive,
    }
  }
}
