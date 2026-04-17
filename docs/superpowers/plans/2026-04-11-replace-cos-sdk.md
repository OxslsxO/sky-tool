# Replace COS SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deprecated COS SDK dependency chain with an S3-compatible client while preserving the current storage module behavior.

**Architecture:** Keep the public `createStorage()` interface unchanged and swap only the COS-backed implementation in `backend/lib/storage.js`. Use Tencent COS's S3-compatible endpoint with AWS SDK v3 so uploads, downloads, health reporting, and generated URLs continue to behave the same for the rest of the backend.

**Tech Stack:** Node.js, `@aws-sdk/client-s3`, built-in `node:test`

---

### Task 1: Replace dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Add `@aws-sdk/client-s3` and remove `cos-nodejs-sdk-v5`.
- [ ] Run `npm install` to refresh the lockfile.

### Task 2: Update storage implementation

**Files:**
- Modify: `backend/lib/storage.js`
- Delete: `backend/lib/install-punycode-warning-filter.js`

- [ ] Replace COS SDK usage with `S3Client`, `PutObjectCommand`, and `GetObjectCommand`.
- [ ] Point the client at the Tencent COS endpoint derived from bucket and region.
- [ ] Preserve current `saveBuffer`, `readRemoteObject`, `cleanupExpiredLocalOutputs`, and `getHealth` behavior.
- [ ] Remove the temporary punycode warning filter once the deprecated dependency is gone.

### Task 3: Add regression tests

**Files:**
- Modify: `backend/lib/storage-warning.test.js`

- [ ] Keep the no-warning load test.
- [ ] Replace the warning-filter-specific test with a behavior test that asserts `createStorage().getHealth()` still reports COS mode when COS env vars are present.

### Task 4: Verify the migration

**Files:**
- None

- [ ] Run `node --test backend/lib/storage-warning.test.js`.
- [ ] Run `npm run backend:start` and confirm startup has no `DEP0040` warning.
- [ ] Request `http://127.0.0.1:3100/health` and confirm the backend is still healthy and reports COS storage.
