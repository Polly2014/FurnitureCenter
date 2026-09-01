# Responsive Context Drawer Design

## Goal

Keep furniture details and the inventory map beside the query workflow without forcing medium-width browsers to scroll into a second page row.

## Responsive behavior

- Wide screens above 1124px retain the resizable three-column workspace.
- Medium screens from 761px through 1124px keep the catalog and Chat visible and place contextual content in a 440px right-side overlay drawer.
- Small screens up to 760px use the same contextual content as a bottom sheet.
- The contextual surface is closed on first entry. Selecting a catalog item, selecting a map location, or receiving a useful Chat result opens it.
- A single-result Chat response opens the furniture detail view. A multi-result response opens the inventory map.
- The drawer header provides `家具详情` and `库存位置` tabs plus an explicit close button. Escape and the backdrop also close it.

## Accessibility and motion

The closed overlay is hidden with CSS visibility as well as pointer-event suppression so its descendants cannot receive focus. Tabs expose their selected state, the close button has a concrete accessible name, and Escape mirrors the visible close action. Motion is reduced when the operating system requests reduced motion.

## Verification

Component tests cover initial closed state, catalog-triggered opening, tab switching, explicit close, and Chat-triggered opening. Browser checks cover 1087px medium layout, wide fixed layout, and mobile bottom-sheet placement.
