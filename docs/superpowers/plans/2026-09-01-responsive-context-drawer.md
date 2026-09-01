# Responsive Context Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the medium-width stacked context row with an adaptive right drawer and mobile bottom sheet while preserving the wide three-column workspace.

**Architecture:** `FurnitureApp` owns drawer visibility and active context tab because catalog selection and streamed Chat results already converge there. Existing detail and map components remain unchanged; responsive CSS changes only their presentation.

**Tech Stack:** React 19, TypeScript, CSS media queries, Vitest, Testing Library

**Spec:** `docs/plans/2026-09-01-responsive-context-drawer-design.md`

## Global Constraints

- Production and `fc.polly.wang` remain untouched; deployment targets Preview only.
- No new runtime dependency.
- The existing wide-screen resize handles continue to work.

---

### Task 1: Drawer interaction contract

**Files:**
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: existing catalog selection and `streamAgent` result callbacks
- Produces: `contextOpen` and `contextTab` UI state, tab buttons, `关闭详情面板` action

- [x] Add a component test showing the panel starts closed, a catalog item opens furniture details, the location tab switches content, and close hides the panel.
- [x] Run `npm test -- App.test.tsx` in `frontend/` and confirm the missing close action makes the test fail.
- [x] Add the minimum state and event wiring in `App.tsx`, including Escape and backdrop close behavior.
- [x] Run `npm test -- App.test.tsx` and confirm the interaction tests pass.

### Task 2: Chat-driven context

**Files:**
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `QueryResult` emitted by `streamAgent`
- Produces: detail tab for one item and map tab for multiple mapped results

- [x] Add a test showing a useful Chat result opens the contextual surface.
- [x] Run the targeted test and confirm it fails before result handling changes.
- [x] Open the appropriate tab from `onResult` without changing streaming behavior.
- [x] Run the targeted test and the full frontend suite.

### Task 3: Adaptive presentation

**Files:**
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes: `.is-open`, `.is-detail-view`, and `.is-map-view` state classes
- Produces: fixed wide rail, medium right drawer, and mobile bottom sheet

- [x] Change the 1124px breakpoint to a single-row catalog/Chat grid and position the context panel above it as a right drawer.
- [x] Change the 760px breakpoint to present the same panel from the bottom.
- [x] Preserve wide-screen detail/map stacking and add reduced-motion handling.
- [x] Run `npm test`, `npm run lint`, and `npm run build` in `frontend/`.
- [x] Verify the three target viewport modes in a browser.

### Task 4: Preview validation

**Files:**
- No source changes expected

**Interfaces:**
- Consumes: the repository Preview deployment command
- Produces: a testable Cloudflare Preview version

- [x] Deploy only to `furniture-center-preview.26716201.workers.dev`.
- [x] In the in-app browser, verify first-entry closed state, selection open, tab switching, close, Chat open, and mobile positioning.
- [x] Review the final diff and report the exact verification evidence.
