# Direct Tool Operation Design

## Goal

Make every tool open directly into an operable page. Users should be able to upload, input, configure, and execute from the first page they enter, without an intermediate "enter workbench" step.

## Approved UX Direction

- `pages/tool-detail` becomes the primary tool page.
- The first visible section is the operation UI.
- Existing helper copy, scenarios, favorites, and recent tasks remain available but move below the operation area.
- `pages/workbench` stops being a primary user destination. Existing links that re-open a tool should route to `pages/tool-detail`.

## Page Responsibilities

### `pages/tool-detail`

- Load the selected tool and default or passed selections.
- Render the same operation controls currently shown in `pages/workbench`.
- Execute client-side tools directly.
- Execute backend tools directly, including file selection and service configuration prompts.
- Preserve existing detail-only affordances such as favorites and related task history.

### `pages/workbench`

- No longer acts as the main interaction surface for user entry.
- Can remain temporarily for compatibility, but new primary flows should not route users there.

## Navigation Changes

- Home and category already route to `pages/tool-detail`; keep that.
- Retry/reopen flows that currently route to `pages/workbench` should route to `pages/tool-detail` with preserved selections.
- User-facing copy that mentions "entering the workbench" should be removed.

## Implementation Shape

- Extract the reusable operation logic from `pages/workbench/index.js` into a shared module.
- Have both `pages/tool-detail` and `pages/workbench` consume the shared runtime during transition.
- Replace the current `tool-detail` CTA-only structure with a direct-operation layout that embeds upload, input, execution, and backend-state UI.

## Risks

- The current workbench file is large, so careless copying could create divergence.
- Some tools depend on hidden canvas rendering and file-picker state; those behaviors must stay intact after extraction.
- Retry flows must preserve `selections` so users reopen tools in the same configured state.

## Verification

- Regression tests must fail if user entry pages still navigate to `pages/workbench`.
- Regression tests must fail if tool-detail still renders "enter workbench" copy.
- Miniapp import checks must continue to pass.
- Existing Node-side regression tests for startup and miniapp imports must remain green.
