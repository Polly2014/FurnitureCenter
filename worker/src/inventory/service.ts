import { ApplicationError } from '../catalog/models'
import { sha256Hex } from '../auth/tokens'
import {
  D1InventoryRepository,
  type InventorySnapshot,
  type TransferListFilters,
} from './repository'

type IdempotencyContext = {
  tokenId: string
  idempotencyKey: string
}

export type CreateInventoryPositionCommand = {
  furnitureId: string
  siteId: string
  quantityTotal: number
  quantityAvailable: number
  actor: string
}

export type AdjustInventoryCommand = IdempotencyContext & {
  inventoryId: string
  deltaTotal: number
  deltaAvailable: number
  kind: string
  reason: string
  actor: string
  expectedVersion: number | null
}

export type TransferInventoryCommand = IdempotencyContext & {
  sourceInventoryId: string
  destinationSiteId: string
  quantity: number
  reason: string
  actor: string
  expectedSourceVersion: number
}

export class InventoryService {
  constructor(private readonly repository: D1InventoryRepository) {}

  async createPosition(command: CreateInventoryPositionCommand): Promise<InventorySnapshot> {
    this.validateQuantityPair(command.quantityTotal, command.quantityAvailable)
    if (!(await this.repository.furnitureExists(command.furnitureId))) {
      throw new ApplicationError(404, `Furniture not found: ${command.furnitureId}`)
    }
    if (!(await this.repository.siteExists(command.siteId))) {
      throw new ApplicationError(404, `Site not found: ${command.siteId}`)
    }
    if (await this.repository.positionForSite(command.furnitureId, command.siteId)) {
      throw new ApplicationError(409, 'inventory position already exists for this site')
    }
    try {
      return await this.repository.createPosition(command)
    } catch {
      throw new ApplicationError(409, 'inventory position already exists for this site')
    }
  }

  async adjust(command: AdjustInventoryCommand): Promise<InventorySnapshot> {
    if (command.deltaTotal === 0 && command.deltaAvailable === 0) {
      throw new ApplicationError(422, 'inventory adjustment cannot leave both quantities unchanged')
    }
    if (!command.kind) throw new ApplicationError(422, 'inventory adjustment kind is required')
    if (!command.reason) throw new ApplicationError(422, 'inventory adjustment reason is required')
    this.validateIdempotencyKey(command.idempotencyKey)
    const operation = `inventory-adjust:${command.inventoryId}`
    const keyHash = await sha256Hex(command.idempotencyKey)
    const requestHash = await sha256Hex(JSON.stringify({
      inventory_id: command.inventoryId,
      delta_total: command.deltaTotal,
      delta_available: command.deltaAvailable,
      kind: command.kind,
      reason: command.reason,
      expected_version: command.expectedVersion,
    }))
    const replay = await this.replay<InventorySnapshot>(
      command.tokenId,
      operation,
      keyHash,
      requestHash,
    )
    if (replay) return replay
    const current = await this.repository.position(command.inventoryId)
    if (!current) {
      throw new ApplicationError(404, `Inventory position not found: ${command.inventoryId}`)
    }
    if (command.expectedVersion !== null && command.expectedVersion !== current.version) {
      throw new ApplicationError(409, 'inventory position changed; refresh and retry')
    }
    const totalAfter = current.quantity_total + command.deltaTotal
    const availableAfter = current.quantity_available + command.deltaAvailable
    this.validateQuantityPair(totalAfter, availableAfter)
    try {
      return await this.repository.adjust(
        { ...command, operation, keyHash, requestHash },
        current,
        command.expectedVersion ?? current.version,
        totalAfter,
        availableAfter,
      )
    } catch {
      const concurrentReplay = await this.replay<InventorySnapshot>(
        command.tokenId,
        operation,
        keyHash,
        requestHash,
      )
      if (concurrentReplay) return concurrentReplay
      throw new ApplicationError(409, 'inventory position changed; refresh and retry')
    }
  }

  async transfer(command: TransferInventoryCommand) {
    if (!Number.isInteger(command.quantity) || command.quantity <= 0) {
      throw new ApplicationError(422, 'transfer quantity must be positive')
    }
    if (!command.reason) throw new ApplicationError(422, 'inventory transfer reason is required')
    this.validateIdempotencyKey(command.idempotencyKey)
    if (!Number.isInteger(command.expectedSourceVersion) || command.expectedSourceVersion < 1) {
      throw new ApplicationError(422, 'expected source version must be positive')
    }
    const operation = `inventory-transfer:${command.sourceInventoryId}`
    const keyHash = await sha256Hex(command.idempotencyKey)
    const requestHash = await sha256Hex(JSON.stringify({
      source_inventory_id: command.sourceInventoryId,
      destination_site_id: command.destinationSiteId,
      quantity: command.quantity,
      reason: command.reason,
      expected_source_version: command.expectedSourceVersion,
    }))
    const replay = await this.replay<Awaited<ReturnType<D1InventoryRepository['transfer']>>>(
      command.tokenId,
      operation,
      keyHash,
      requestHash,
    )
    if (replay) return replay
    const source = await this.repository.position(command.sourceInventoryId)
    if (!source) {
      throw new ApplicationError(404, `Inventory position not found: ${command.sourceInventoryId}`)
    }
    const destinationSite = await this.repository.site(command.destinationSiteId)
    if (!destinationSite) {
      throw new ApplicationError(404, `Site not found: ${command.destinationSiteId}`)
    }
    if (destinationSite.is_active !== 1) {
      throw new ApplicationError(422, 'destination site is inactive')
    }
    if (source.site_id === command.destinationSiteId) {
      throw new ApplicationError(422, 'source and destination sites must be different')
    }
    if (source.version !== command.expectedSourceVersion) {
      throw new ApplicationError(409, 'inventory position changed; refresh and retry')
    }
    if (source.status !== 'active') {
      throw new ApplicationError(409, 'shared listing is already closed')
    }
    if (source.quantity_available < command.quantity) {
      throw new ApplicationError(422, 'transfer quantity exceeds available shared quantity')
    }
    try {
      return await this.repository.transfer(
        { ...command, operation, keyHash, requestHash },
        source,
      )
    } catch {
      const concurrentReplay = await this.replay<
        Awaited<ReturnType<D1InventoryRepository['transfer']>>
      >(command.tokenId, operation, keyHash, requestHash)
      if (concurrentReplay) return concurrentReplay
      throw new ApplicationError(409, 'inventory position changed; refresh and retry')
    }
  }

  async listTransfers(options: {
    furnitureId?: string
    sourceSiteId?: string
    destinationSiteId?: string
    from?: string
    to?: string
    cursor?: string
    limit?: number
  }) {
    const limit = options.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApplicationError(422, 'limit must be between 1 and 100')
    }
    const from = this.optionalDate(options.from, 'from')
    const to = this.optionalDate(options.to, 'to')
    if (from && to && from > to) {
      throw new ApplicationError(422, 'from must not be later than to')
    }
    const filters: TransferListFilters = {
      furnitureId: options.furnitureId?.trim() || null,
      sourceSiteId: options.sourceSiteId?.trim() || null,
      destinationSiteId: options.destinationSiteId?.trim() || null,
      from,
      to,
      cursor: this.decodeCursor(options.cursor),
      limit,
    }
    const rows = await this.repository.listTransfers(filters)
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    return {
      items,
      next_cursor: hasMore && last
        ? btoa(`${last.created_at}|${last.id}`)
        : null,
    }
  }

  private async replay<T>(
    tokenId: string,
    operation: string,
    keyHash: string,
    requestHash: string,
  ): Promise<T | null> {
    const record = await this.repository.idempotencyRecord(tokenId, operation, keyHash)
    if (!record) return null
    if (record.request_hash !== requestHash) {
      throw new ApplicationError(409, 'idempotency key was already used for a different request')
    }
    try {
      return JSON.parse(record.response_json) as T
    } catch {
      throw new Error('stored idempotency response is invalid')
    }
  }

  private validateIdempotencyKey(key: string) {
    if (key.length < 8 || key.length > 200 || /\s/u.test(key)) {
      throw new ApplicationError(422, 'Idempotency-Key must contain 8 to 200 non-space characters')
    }
  }

  private validateQuantityPair(total: number, available: number) {
    if (!Number.isInteger(total) || !Number.isInteger(available)) {
      throw new ApplicationError(422, 'inventory quantities must be integers')
    }
    if (total < 0) throw new ApplicationError(422, 'inventory total cannot be negative')
    if (available < 0 || available > total) {
      throw new ApplicationError(422, 'available quantity must be between zero and total')
    }
  }

  private optionalDate(value: string | undefined, field: string) {
    if (!value) return null
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) {
      throw new ApplicationError(422, `${field} must be an ISO date or timestamp`)
    }
    return new Date(timestamp).toISOString()
  }

  private decodeCursor(value: string | undefined) {
    if (!value) return null
    try {
      const decoded = atob(value)
      const separator = decoded.lastIndexOf('|')
      if (separator < 1) throw new Error('invalid cursor')
      const createdAt = decoded.slice(0, separator)
      const id = decoded.slice(separator + 1)
      if (!id || Number.isNaN(Date.parse(createdAt))) throw new Error('invalid cursor')
      return { createdAt, id }
    } catch {
      throw new ApplicationError(422, 'cursor is invalid')
    }
  }
}
