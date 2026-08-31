const requiredTools = new Set([
  'search_furniture',
  'get_furniture',
  'list_sites',
  'list_categories',
])

function classify(question) {
  const normalized = question.toLowerCase()
  if (normalized.includes('valid category filters')) return 'taxonomy'
  if (normalized.includes('registered site has no')) return 'empty_site'
  if (normalized.includes('represented at all three')) return 'category_coverage'
  if (normalized.includes('haworth')) return 'item_details'
  if (normalized.includes('mention wood')) return 'material_availability'
  if (normalized.includes('even when unavailable')) return 'all_seating'
  if (normalized.includes('seating is available')) return 'available_seating'
  if (['beijing', 'shanghai', 'shenzhen'].some((place) => normalized.includes(place))) {
    return 'site_availability'
  }
  if (normalized.includes('available furniture')) return 'available_overview'
  throw new Error(`The evaluation agent cannot classify this question: ${question}`)
}

function sortedEntries(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)))
}

function itemQuantities(items, siteId) {
  return sortedEntries(Object.fromEntries(items.map((item) => {
    const quantity = siteId
      ? item.inventory.find((position) => position.site_id === siteId)?.quantity_available ?? 0
      : item.quantity_available
    return [item.id, quantity]
  })))
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

function answerText(intent, items, facts) {
  const names = items.map((item) => item.name).join(', ')
  switch (intent) {
    case 'available_overview':
      return `Available furniture: ${names}. Inventory by site: ${JSON.stringify(facts.availability)}.`
    case 'available_seating':
      return `Available seating: ${names}. Inventory by site: ${JSON.stringify(facts.availability)}.`
    case 'all_seating':
      return `Seating catalog: ${names}. Quantities: ${JSON.stringify(facts.item_quantities)}.`
    case 'site_availability':
      return `Available at ${facts.site_id}: ${names}; combined quantity ${facts.combined_quantity}.`
    case 'item_details':
      return `${names}: SKU ${facts.sku}, condition ${facts.condition}, ${facts.quantity_available} available, ${facts.image_count} image(s).`
    case 'category_coverage':
      return `${facts.category} is represented at ${facts.site_ids.join(', ')}.`
    case 'material_availability':
      return `Wood furniture: ${names}. Inventory by site: ${JSON.stringify(facts.availability)}.`
    case 'empty_site':
      return `${facts.site_id} has no available furniture; positioned inventory: ${JSON.stringify(facts.item_quantities)}.`
    case 'taxonomy':
      return `Category filters: ${facts.category_names.join(', ')}. Categories with unavailable items: ${facts.unavailable_category_names.join(', ')}.`
    default:
      throw new Error(`Unhandled answer intent: ${intent}`)
  }
}

function siteCodeInQuestion(question) {
  const normalized = question.toLowerCase()
  if (normalized.includes('beijing')) return 'BJ'
  if (normalized.includes('shanghai')) return 'SH'
  if (normalized.includes('shenzhen')) return 'SZ'
  return null
}

export async function answerFurnitureQuestion(question, client) {
  const discovered = await client.listTools()
  const toolNames = new Set(discovered.tools.map((tool) => tool.name))
  for (const name of requiredTools) {
    if (!toolNames.has(name)) throw new Error(`Required MCP tool is missing: ${name}`)
  }

  const calls = []
  const call = async (name, args) => {
    calls.push({ name, arguments: args })
    const result = await client.callTool({ name, arguments: args })
    if (result.isError || result.structuredContent?.ok !== true) {
      throw new Error(result.content?.[0]?.text ?? `${name} failed`)
    }
    return result.structuredContent
  }

  const intent = classify(question)
  let items = []
  let facts

  if (intent === 'site_availability') {
    const sites = (await call('list_sites', {})).sites
    const code = siteCodeInQuestion(question)
    const site = sites.find((candidate) => candidate.code === code)
    if (!site) throw new Error(`No registered site matches ${code}`)
    items = (await call('search_furniture', {
      site_id: site.id,
      available_only: true,
      limit: 50,
    })).items
    const quantities = itemQuantities(items, site.id)
    facts = {
      intent,
      site_id: site.id,
      item_quantities: quantities,
      combined_quantity: Object.values(quantities).reduce((total, quantity) => total + quantity, 0),
    }
  } else if (intent === 'available_overview') {
    items = (await call('search_furniture', { available_only: true, limit: 50 })).items
    facts = {
      intent,
      item_ids: items.map((item) => item.id).sort(),
      availability: availability(items),
    }
  } else if (intent === 'available_seating') {
    items = (await call('search_furniture', {
      text: 'chair', available_only: true, limit: 50,
    })).items
    facts = {
      intent,
      item_ids: items.map((item) => item.id).sort(),
      availability: availability(items),
    }
  } else if (intent === 'all_seating') {
    items = (await call('search_furniture', {
      text: 'chair', available_only: false, limit: 50,
    })).items
    facts = {
      intent,
      item_quantities: itemQuantities(items),
      unavailable_item_ids: items
        .filter((item) => item.quantity_available === 0)
        .map((item) => item.id)
        .sort(),
    }
  } else if (intent === 'item_details') {
    const matches = (await call('search_furniture', {
      text: 'Haworth', available_only: true, limit: 50,
    })).items
    if (matches.length !== 1) throw new Error(`Expected one Haworth match, received ${matches.length}`)
    const item = (await call('get_furniture', { furniture_id: matches[0].id })).item
    items = [item]
    facts = {
      intent,
      item_id: item.id,
      sku: item.sku,
      condition: item.condition,
      quantity_available: item.quantity_available,
      image_count: item.images.length,
    }
  } else if (intent === 'category_coverage') {
    await call('list_sites', {})
    items = (await call('search_furniture', {
      text: 'chair', available_only: false, limit: 50,
    })).items
    facts = {
      intent,
      category: [...new Set(items.map((item) => item.category))].sort().join(', '),
      site_ids: [...new Set(items.flatMap((item) => item.inventory.map((position) => position.site_id)))].sort(),
    }
  } else if (intent === 'material_availability') {
    items = (await call('search_furniture', {
      text: '木质', available_only: true, limit: 50,
    })).items
    facts = {
      intent,
      item_ids: items.map((item) => item.id).sort(),
      availability: availability(items),
    }
  } else if (intent === 'empty_site') {
    const sites = (await call('list_sites', {})).sites
    items = (await call('search_furniture', { available_only: false, limit: 50 })).items
    const emptySites = sites.filter((site) => items.every((item) => (
      item.inventory.find((position) => position.site_id === site.id)?.quantity_available ?? 0
    ) === 0))
    if (emptySites.length !== 1) throw new Error(`Expected one empty site, received ${emptySites.length}`)
    const site = emptySites[0]
    const positioned = items.filter((item) => item.inventory.some((position) => position.site_id === site.id))
    facts = {
      intent,
      site_id: site.id,
      item_quantities: itemQuantities(positioned, site.id),
    }
    items = positioned
  } else if (intent === 'taxonomy') {
    const categories = (await call('list_categories', {})).categories
    items = (await call('search_furniture', { available_only: false, limit: 50 })).items
    facts = {
      intent,
      category_names: categories.map((category) => category.name).sort(),
      unavailable_category_names: [...new Set(items
        .filter((item) => item.quantity_available === 0)
        .map((item) => item.category))].sort(),
    }
  }

  return {
    text: answerText(intent, items, facts),
    facts,
    calls,
  }
}
