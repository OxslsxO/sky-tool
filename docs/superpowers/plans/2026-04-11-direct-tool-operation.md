# Direct Tool Operation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every tool open directly into an operable page instead of requiring a second jump into a workbench.

**Architecture:** Move the executable tool runtime into a shared module, then let `pages/tool-detail` become the main execution surface while `pages/workbench` becomes a compatibility shell. Update user-entry navigation and copy so all primary flows land on the direct-operation page.

**Tech Stack:** WeChat Mini Program pages, shared CommonJS runtime helpers, Node `node:test`

---

### Task 1: Lock the entry-flow regression

**Files:**
- Create: `pages/tool-entry-regression.test.js`

- [ ] Add a test that fails if `pages/tool-detail/index.js` or `pages/task-detail/index.js` routes users to `/pages/workbench/index`.
- [ ] Add a test that fails if `pages/tool-detail` still contains "进入真实工作台", "进入云处理工作台", or `launchCopy`.

### Task 2: Extract shared tool runtime

**Files:**
- Create: `utils/tool-runtime-page.js`
- Modify: `pages/workbench/index.js`

- [ ] Move reusable tool loading, picker, execution, and task-creation logic from `pages/workbench/index.js` into `utils/tool-runtime-page.js`.
- [ ] Keep `pages/workbench/index.js` working by consuming the shared runtime module.

### Task 3: Convert tool-detail into the direct-operation page

**Files:**
- Modify: `pages/tool-detail/index.js`
- Modify: `pages/tool-detail/index.wxml`
- Modify: `pages/tool-detail/index.wxss`

- [ ] Replace CTA-only page behavior with shared runtime behavior plus detail-specific fields.
- [ ] Put operation controls above descriptive content.
- [ ] Remove workbench-entry copy and button behavior.
- [ ] Keep favorites, category, billing, and related tasks below the operation area.

### Task 4: Update retry and reopen flows

**Files:**
- Modify: `pages/task-detail/index.js`

- [ ] Update retry/reopen navigation to point at `pages/tool-detail/index` with preserved `selections`.

### Task 5: Verify

**Files:**
- None

- [ ] Run `node --test pages/tool-entry-regression.test.js`.
- [ ] Run `node --test scripts/check-miniapp-imports.test.js`.
- [ ] Run `node --test backend/lib/storage-warning.test.js backend/server-startup.test.js`.
