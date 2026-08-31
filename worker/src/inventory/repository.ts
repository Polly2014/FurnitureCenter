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

  position(id: string) {
    return this.database
      .prepare(
        `SELECT id, furniture_id, site_id, quantity_total, quantity_available, version
         FROM inventory WHERE id = ?`,
      )
      .bind(id)
      .first<InventoryRow>()
  }

  positionForSite(furnitureId: string, siteId: string) {
    return this.database
      .prepare(
        `SELECT id, furniture_id, site_id, quantity_total, quantity_available, version
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

  async transfer(
    command: PersistedTransferCommand,
    source: InventoryRow,
    destination: InventoryRow | null,
  ) {
    const transferId = crypto.randomUUID()
    const destinationId = destination?.id ?? crypto.randomUUID()
    const destinationTotalBefore = destination?.quantity_total ?? 0
    const destinationAvailableBefore = destination?.quantity_available ?? 0
    const destinationVersion = destination?.version ?? 0
    const sourceTotalAfter = source.quantity_total - command.quantity
    const sourceAvailableAfter = source.quantity_available - command.quantity
    const destinationTotalAfter = destinationTotalBefore + command.quantity
    const destinationAvailableAfter = destinationAvailableBefore + command.quantity
    const response = {
      transfer_id: transferId,
      source: {
        inventory_id: source.id,
        quantity_total: sourceTotalAfter,
        quantity_available: sourceAvailableAfter,
        version: source.version + 1,
      },
      destination: {
        inventory_id: destinationId,
        quantity_total: destinationTotalAfter,
        quantity_available: destinationAvailableAfter,
        version: destinationVersion + 1,
      },
    }
    const statements: D1PreparedStatement[] = [
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
        .bind(
          sourceTotalAfter,
          sourceAvailableAfter,
          source.id,
          command.expectedSourceVersion,
        ),
      this.adjustment(
        source.id,
        'transfer_out',
        -command.quantity,
        source.quantity_total,
        sourceTotalAfter,
        source.quantity_available,
        sourceAvailableAfter,
        transferId,
        command.reason,
        command.actor,
        true,
      ),
    ]
    if (destination) {
      statements.push(
        this.database
          .prepare(
            `UPDATE inventory
             SET quantity_total = ?, quantity_available = ?, version = version + 1
             WHERE id = ? AND version = ?`,
          )
          .bind(
            destinationTotalAfter,
            destinationAvailableAfter,
            destination.id,
            destination.version,
          ),
      )
    } else {
      statements.push(
        this.database
          .prepare(
            `INSERT INTO inventory
              (id, furniture_id, site_id, quantity_total, quantity_available, version)
             VALUES (?, ?, ?, ?, ?, 1)`,
          )
          .bind(
            destinationId,
            source.furniture_id,
            command.destinationSiteId,
            destinationTotalAfter,
            destinationAvailableAfter,
          ),
      )
    }
    statements.push(
      this.adjustment(
        destinationId,
        'transfer_in',
        command.quantity,
        destinationTotalBefore,
        destinationTotalAfter,
        destinationAvailableBefore,
        destinationAvailableAfter,
        transferId,
        command.reason,
        command.actor,
        true,
      ),
      this.audit(
        'inventory_transfer',
        transferId,
        'created',
        command.actor,
        {
          source_inventory_id: source.id,
          destination_inventory_id: destinationId,
          quantity: command.quantity,
          reason: command.reason,
        },
      ),
    )
    await this.database.batch(statements)
    return response
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
    delta: number,
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
        delta,
        delta,
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
