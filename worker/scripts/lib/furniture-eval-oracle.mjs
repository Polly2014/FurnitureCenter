function availableQuantity(item, siteId) {
  return item.inventory
    .filter((position) => !siteId || position.site_id === siteId)
    .reduce((total, position) => total + position.quantity_available, 0)
}

function sortedEntries(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)))
}

function itemQuantities(items, siteId) {
  return sortedEntries(Object.fromEntries(items.map((item) => [item.id, availableQuantity(item, siteId)])))
}

function availability(items) {
  return sortedEntries(Object.fromEntries(items.map((item) => [
    item.id,
    item.inventory
      .filter((position) => position.quantity_available > 0)
      .map((position) => [position.site_id, position.quantity_available])
      .sort(([left], [right]) => left.localeCompare(right)),
  ])))
}

export function expectedFurnitureFacts(evaluationId, fixture) {
  const categoryNames = new Map(fixture.categories.map((category) => [category.id, category.name]))
  const furniture = fixture.furniture.map((item) => ({
    ...item,
    category: categoryNames.get(item.category_id),
  }))
  const available = furniture.filter((item) => availableQuantity(item) > 0)
  const seating = furniture.filter((item) => item.category === '座椅')
  const siteByCode = (code) => fixture.sites.find((site) => site.code === code)

  if (evaluationId === 'available-overview') {
    return {
      intent: 'available_overview',
      item_ids: available.map((item) => item.id).sort(),
      availability: availability(available),
    }
  }
  if (evaluationId === 'chair-distribution') {
    const items = seating.filter((item) => availableQuantity(item) > 0)
    return {
      intent: 'available_seating',
      item_ids: items.map((item) => item.id).sort(),
      availability: availability(items),
    }
  }
  if (evaluationId === 'include-unavailable-seating') {
    return {
      intent: 'all_seating',
      item_quantities: itemQuantities(seating),
      unavailable_item_ids: seating
        .filter((item) => availableQuantity(item) === 0)
        .map((item) => item.id)
        .sort(),
    }
  }
  if (evaluationId === 'beijing-reuse' || evaluationId === 'shanghai-meeting-options') {
    const site = siteByCode(evaluationId === 'beijing-reuse' ? 'BJ' : 'SH')
    const items = furniture.filter((item) => availableQuantity(item, site.id) > 0)
    const quantities = itemQuantities(items, site.id)
    return {
      intent: 'site_availability',
      site_id: site.id,
      item_quantities: quantities,
      combined_quantity: Object.values(quantities).reduce((total, quantity) => total + quantity, 0),
    }
  }
  if (evaluationId === 'haworth-details') {
    const item = furniture.find((candidate) => candidate.brand === 'Haworth')
    return {
      intent: 'item_details',
      item_id: item.id,
      sku: item.sku,
      condition: item.condition,
      quantity_available: availableQuantity(item),
      image_count: item.images.length,
    }
  }
  if (evaluationId === 'category-site-coverage') {
    return {
      intent: 'category_coverage',
      category: '座椅',
      site_ids: [...new Set(seating.flatMap((item) => item.inventory.map((position) => position.site_id)))].sort(),
    }
  }
  if (evaluationId === 'wood-items') {
    const items = available.filter((item) => item.material.includes('木质'))
    return {
      intent: 'material_availability',
      item_ids: items.map((item) => item.id).sort(),
      availability: availability(items),
    }
  }
  if (evaluationId === 'site-without-availability') {
    const site = fixture.sites.find((candidate) => furniture.every(
      (item) => availableQuantity(item, candidate.id) === 0,
    ))
    const items = furniture.filter((item) => item.inventory.some((position) => position.site_id === site.id))
    return {
      intent: 'empty_site',
      site_id: site.id,
      item_quantities: itemQuantities(items, site.id),
    }
  }
  if (evaluationId === 'stable-taxonomy') {
    return {
      intent: 'taxonomy',
      category_names: fixture.categories.map((category) => category.name).sort(),
      unavailable_category_names: [...new Set(furniture
        .filter((item) => availableQuantity(item) === 0)
        .map((item) => item.category))].sort(),
    }
  }
  throw new Error(`No fixture oracle exists for evaluation: ${evaluationId}`)
}
