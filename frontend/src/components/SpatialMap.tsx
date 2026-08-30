import { useEffect, useEffectEvent, useRef } from 'react'
import {
  AttributionControl,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  type StyleSpecification,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { MapFeature } from '../types'

type SpatialMapProps = {
  features: MapFeature[]
  selectedSiteId?: string
  onSelect: (feature: MapFeature) => void
  compact?: boolean
}

const mapStyle: StyleSpecification = {
  version: 8,
  sources: {
    openstreetmap: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'openstreetmap', type: 'raster', source: 'openstreetmap' }],
}

export function SpatialMap({ features, selectedSiteId, onSelect, compact = false }: SpatialMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markersRef = useRef<Marker[]>([])
  const selectFeature = useEffectEvent(onSelect)

  useEffect(() => {
    if (!containerRef.current) return
    const map = new MapLibreMap({
      container: containerRef.current,
      style: mapStyle,
      center: [110.5, 33.5],
      zoom: 3.3,
      attributionControl: false,
    })
    if (!compact) map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right')
    mapRef.current = map
    const resizeObserver = new ResizeObserver(() => map.resize())
    resizeObserver.observe(containerRef.current)
    return () => {
      resizeObserver.disconnect()
      markersRef.current.forEach((marker) => marker.remove())
      map.remove()
      mapRef.current = null
    }
  }, [compact])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const renderMarkers = () => {
      markersRef.current.forEach((marker) => marker.remove())
      markersRef.current = features.map((feature) => {
        const element = document.createElement('button')
        element.type = 'button'
        element.className = `map-marker${feature.site_id === selectedSiteId ? ' is-active' : ''}`
        element.textContent = String(feature.quantity_available)
        element.title = `${feature.site_name} · ${feature.quantity_available} 件可用`
        element.setAttribute('aria-label', element.title)
        element.addEventListener('click', () => selectFeature(feature))
        return new Marker({ element })
          .setLngLat([feature.longitude, feature.latitude])
          .addTo(map)
      })
      if (features.length === 1) {
        map.easeTo({ center: [features[0].longitude, features[0].latitude], zoom: compact ? 6.2 : 8, duration: 700 })
      } else if (features.length > 1) {
        const bounds = new LngLatBounds()
        features.forEach((feature) => bounds.extend([feature.longitude, feature.latitude]))
        map.fitBounds(bounds, { padding: compact ? 28 : 90, maxZoom: compact ? 5.5 : 7, duration: 700 })
      }
    }
    renderMarkers()
  }, [compact, features, selectedSiteId])

  return <div className={`spatial-map${compact ? ' is-compact' : ''}`} ref={containerRef} aria-label="家具库存地图" />
}