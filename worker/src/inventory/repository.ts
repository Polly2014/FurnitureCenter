import type {
  AdjustInventoryCommand,
  CreateInventoryPositionCommand,
  TransferInventoryCommand,
} from './service'

export type InventoryRow = {
  id: string
  furniture_id: string
  site_id: string
  quantity_total: number
  quantity_available: number
  version: number
  status: 'active' | 'allocated' | 'withdrawn'
  closed_at: string | null
  closed_reason: string | null
}

export type InventorySnapshot = {
  inventory_id: string
  quantity_total: number
  quantity_available: number
  version: number
}

type IdempotentFields = {
  operation: string
  keyHash: string
  requestHash: string
}

type PersistedAdjustCommand = AdjustInventoryCommand & IdempotentFields
type PersistedTransferCommand = TransferInventoryCommand & IdempotentFields

export type TransferRecord = {
  id: string
  furniture_id: string
  furniture_sku: string
  furniture_name: string
  source_inventory_id: string
  source_site_id: string
  source_site_code_snapshot: string
  source_site_name_snapshot: string
  destination_site_id: string
  destination_site_code_snapshot: string
  destination_site_name_snapshot: string
  listed_quantity_before: number
  transferred_quantity: number
  unlisted_remainder: number
  reason: string
  actor_token_id: string
  actor_label_snapshot: string
  created_at: string
}

export type TransferListFilters = {
  furnitureId: string | null
  sourceSiteId: string | null
  destinationSiteId: string | null
  from: string | null
  to: string | null
  cursor: { createdAt: string; id: string } | null
  limit: number
}

type SiteSnapshot = {
  id: string
  code: string
  name: string
  is_active: number
}

export type IdempotencyRecord = {
  request_hash: string
  response_status: number
  response_json: string
}

function snapshot(row: InventoryRow): InventorySnapshot {
  return {
    inventory_id: row.id,
    quantity_total: row.quantity_total,
    quantity_available: row.quantity_available,
    version: row.version,
  }
}

export class D1InventoryRepository {
  constructor(private readonly database: D1Database) {}

  async furnitureExists(id: string) {
    return Boolean(
      await this.database.prepare('SELECT 1 FROM furniture WHERE id = ?').bind(id).first(),
    )
  }

  async siteExists(id: string) {
    return Boolean(await this.database.prepare('SELECT 1 FROM sites WHERE id = ?').bind(id).first())
  }

  site(id: string) {
    return this.database.prepare(
      'SELECT id, code, name, is_active FROM sites WHERE id = ?',
    ).bind(id).first<SiteSnapshot>()
  }

  async tokenLabel(id: string) {
    const row = await this.database.prepare(
      'SELECT label FROM access_tokens WHERE id = ?',
    ).bind(id).first<{ label: string }>()
    return row?.label ?? id
  }

  position(id: string) {
    return this.database
      .prepare(
        `SELECT id, furniture_id, site_id, quantity_total, quantity_available, version,
                status, closed_at, closed_reason
         FROM inventory WHERE id = ?`,
      )
      .bind(id)
      .first<InventoryRow>()
  }

  positionForSite(furnitureId: string, siteId: string) {
    return this.database
      .prepare(
        `SELECT id, furniture_id, site_id, quantity_total, quantity_available, version,
                status, closed_at, closed_reason
         FROM inventory WHERE furniture_id = ? AND site_id = ?`,
      )
      .bind(furnitureId, siteId)
      .first<InventoryRow>()
  }

  idempotencyRecord(tokenId: string, operation: string, keyHash: string) {
    return this.database
      .prepare(
        `SELECT request_hash, response_status, response_json
         FROM idempotency_records
         WHERE token_id = ? AND operation = ? AND key_hash = ?`,
      )
      .bind(tokenId, operation, keyHash)
      .first<IdempotencyRecord>()
  }

  async createPosition(command: CreateInventoryPositionCommand) {
    const id = crypto.randomUUID()
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO inventory
            (id, furniture_id, site_id, quantity_total, quantity_available, version)
           VALUES (?, ?, ?, ?, ?, 1)`,
        )
        .bind(
          id,
          command.furnitureId,
          command.siteId,
          command.quantityTotal,
          command.quantityAvailable,
        ),
      this.audit(
        'inventory',
        id,
        'created',
        command.actor,
        {
          furniture_id: command.furnitureId,
          site_id: command.siteId,
          quantity_total: command.quantityTotal,
          quantity_available: command.quantityAvailable,
        },
      ),
    ])
    return {
      inventory_id: id,
      quantity_total: command.quantityTotal,
      quantity_available: command.quantityAvailable,
      version: 1,
    }
  }

  async adjust(
    command: PersistedAdjustCommand,
    current: InventoryRow,
    expectedVersion: number,
    totalAfter: number,
    availableAfter: number,
  ) {
    const nextVersion = expectedVersion + 1
    const response: InventorySnapshot = {
      inventory_id: current.id,
      quantity_total: totalAfter,
      quantity_available: availableAfter,
      version: nextVersion,
    }
    await this.database.batch([
      this.idempotencyStatement(
        command.tokenId,
        command.operation,
        command.keyHash,
        command.requestHash,
        200,
        response,
      ),
      this.database
        .prepare(
          `UPDATE inventory
           SET quantity_total = ?, quantity_available = ?, version = version + 1
           WHERE id = ? AND version = ?`,
        )
        .bind(totalAfter, availableAfter, current.id, expectedVersion),
      this.database
        .prepare(
          `INSERT INTO inventory_adjustments
            (id, inventory_id, kind, delta_total, delta_available,
             quantity_total_before, quantity_total_after,
             quantity_available_before, quantity_available_after,
             transfer_id, reason, actor)
           VALUES (?, CASE WHEN changes() = 1 THEN ? ELSE NULL END, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          current.id,
          command.kind,
          command.deltaTotal,
          command.deltaAvailable,
          current.quantity_total,
          totalAfter,
          current.quantity_available,
          availableAfter,
          command.reason,
          command.actor,
        ),
      this.audit(
        'inventory',
        current.id,
        'adjusted',
        command.actor,
        {
          kind: command.kind,
          delta_total: command.deltaTotal,
          delta_available: command.deltaAvailable,
          reason: command.reason,
          quantity_total: totalAfter,
          quantity_available: availableAfter,
        },
      ),
    ])
    return response
  }

  async transfer(command: PersistedTransferCommand, source: InventoryRow) {
    const transferId = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const [sourceSite, destinationSite, actorLabel] = await Promise.all([
      this.site(source.site_id),
      this.site(command.destinationSiteId),
      this.tokenLabel(command.tokenId),
    ])
    if (!sourceSite || !destinationSite) throw new Error('transfer site snapshot is unavailable')
    const transfer: Omit<TransferRecord, 'furniture_sku' | 'furniture_name'> = {
      id: transferId,
      furniture_id: source.furniture_id,
      source_inventory_id: source.id,
      source_site_id: sourceSite.id,
      source_site_code_snapshot: sourceSite.code,
      source_site_name_snapshot: sourceSite.name,
      destination_site_id: destinationSite.id,
      destination_site_code_snapshot: destinationSite.code,
      destination_site_name_snapshot: destinationSite.name,
      listed_quantity_before: source.quantity_available,
      transferred_quantity: command.quantity,
      unlisted_remainder: source.quantity_available - command.quantity,
      reason: command.reason,
      actor_token_id: command.tokenId,
      actor_label_snapshot: actorLabel,
      created_at: createdAt,
    }
    const response = {
      transfer,
      source: {
        inventory_id: source.id,
        quantity_total: source.quantity_total,
        quantity_available: 0,
        version: source.version + 1,
        status: 'allocated' as const,
        closed_at: createdAt,
        closed_reason: 'transferred',
      },
    }
    await this.database.batch([
      this.idempotencyStatement(
        command.tokenId,
        command.operation,
        command.keyHash,
        command.requestHash,
        200,
        response,
      ),
      this.database.prepare(
        `UPDATE inventory
         SET quantity_available = 0, status = 'allocated', closed_at = ?,
             closed_reason = 'transferred', version = version + 1
         WHERE id = ? AND version = ? AND status = 'active'
           AND quantity_available = ?
           AND EXISTS (
             SELECT 1 FROM sites
             WHERE id = ? AND is_active = 1
           )`,
      ).bind(
        createdAt,
        source.id,
        command.expectedSourceVersion,
        source.quantity_available,
        command.destinationSiteId,
      ),
      this.database.prepare(
        `INSERT INTO transfer_records
          (id, furniture_id, source_inventory_id,
           source_site_id, source_site_code_snapshot, source_site_name_snapshot,
           destination_site_id, destination_site_code_snapshot, destination_site_name_snapshot,
           listed_quantity_before, transferred_quantity, unlisted_remainder,
           reason, actor_token_id, actor_label_snapshot, created_at)
         VALUES (?, ?, CASE WHEN changes() = 1 THEN ? ELSE NULL END,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        transfer.id,
        transfer.furniture_id,
        transfer.source_inventory_id,
        transfer.source_site_id,
        transfer.source_site_code_snapshot,
        transfer.source_site_name_snapshot,
        transfer.destination_site_id,
        transfer.destination_site_code_snapshot,
        transfer.destination_site_name_snapshot,
        transfer.listed_quantity_before,
        transfer.transferred_quantity,
        transfer.unlisted_remainder,
        transfer.reason,
        transfer.actor_token_id,
        transfer.actor_label_snapshot,
        transfer.created_at,
      ),
      this.adjustment(
        source.id,
        'allocation_close',
        0,
        -source.quantity_available,
        source.quantity_total,
        source.quantity_total,
        source.quantity_available,
        0,
        transferId,
        command.reason,
        command.actor,
        false,
      ),
      this.audit(
        'inventory_transfer',
        transferId,
        'created',
        command.actor,
        {
          source_inventory_id: source.id,
          source_site_id: source.site_id,
          destination_site_id: command.destinationSiteId,
          listed_quantity_before: source.quantity_available,
          transferred_quantity: command.quantity,
          unlisted_remainder: source.quantity_available - command.quantity,
          reason: command.reason,
        },
      ),
    ])
    return response
  }

  async listTransfers(filters: TransferListFilters) {
    const where: string[] = []
    const bindings: Array<string | number> = []
    if (filters.furnitureId) {
      where.push('t.furniture_id = ?')
      bindings.push(filters.furnitureId)
    }
    if (filters.sourceSiteId) {
      where.push('t.source_site_id = ?')
      bindings.push(filters.sourceSiteId)
    }
    if (filters.destinationSiteId) {
      where.push('t.destination_site_id = ?')
      bindings.push(filters.destinationSiteId)
    }
    if (filters.from) {
      where.push('t.created_at >= ?')
      bindings.push(filters.from)
    }
    if (filters.to) {
      where.push('t.created_at <= ?')
      bindings.push(filters.to)
    }
    if (filters.cursor) {
      where.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))')
      bindings.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id)
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = await this.database.prepare(
      `SELECT t.id, t.furniture_id, f.sku AS furniture_sku, f.name AS furniture_name,
              t.source_inventory_id, t.source_site_id,
              t.source_site_code_snapshot, t.source_site_name_snapshot,
              t.destination_site_id, t.destination_site_code_snapshot,
              t.destination_site_name_snapshot, t.listed_quantity_before,
              t.transferred_quantity, t.unlisted_remainder, t.reason,
              t.actor_token_id, t.actor_label_snapshot, t.created_at
       FROM transfer_records t
       JOIN furniture f ON f.id = t.furniture_id
       ${whereClause}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ?`,
    ).bind(...bindings, filters.limit + 1).all<TransferRecord>()
    return rows.results
  }

  private idempotencyStatement(
    tokenId: string,
    operation: string,
    keyHash: string,
    requestHash: string,
    responseStatus: number,
    response: unknown,
  ) {
    return this.database
      .prepare(
        `INSERT INTO idempotency_records
          (id, token_id, operation, key_hash, request_hash, response_status, response_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        tokenId,
        operation,
        keyHash,
        requestHash,
        responseStatus,
        JSON.stringify(response),
      )
  }

  private adjustment(
    inventoryId: string,
    kind: string,
    deltaTotal: number,
    deltaAvailable: number,
    totalBefore: number,
    totalAfter: number,
    availableBefore: number,
    availableAfter: number,
    transferId: string,
    reason: string,
    actor: string,
    requirePreviousChange: boolean,
  ) {
    const inventoryExpression = requirePreviousChange
      ? 'CASE WHEN changes() = 1 THEN ? ELSE NULL END'
      : '?'
    return this.database
      .prepare(
        `INSERT INTO inventory_adjustments
          (id, inventory_id, kind, delta_total, delta_available,
           quantity_total_before, quantity_total_after,
           quantity_available_before, quantity_available_after,
           transfer_id, reason, actor)
         VALUES (?, ${inventoryExpression}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        inventoryId,
        kind,
        deltaTotal,
        deltaAvailable,
        totalBefore,
        totalAfter,
        availableBefore,
        availableAfter,
        transferId,
        reason,
        actor,
      )
  }

  private audit(
    entityType: string,
    entityId: string,
    action: string,
    actor: string,
    details: Record<string, unknown>,
  ) {
    return this.database
      .prepare(
        `INSERT INTO audit_events
          (id, entity_type, entity_id, action, actor, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        entityType,
        entityId,
        action,
        actor,
        JSON.stringify(details),
      )
  }
}
