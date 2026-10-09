# Incident explorer frontend

Serve this directory from the local app's same origin. `index.html` loads `app.js`, `state.js`, `triage.js`, and `styles.css`; requests use the settled `/api/incidents`, `/api/incidents/:id`, `/api/export.csv`, and `/api/overview` endpoints. No dataset or server is embedded in the frontend.

Search is submitted with Search or Enter. Facet, date, sorting, and page-size changes apply immediately and return to page one. Dates and displayed timestamps use UTC. The overview and daily counts describe the full matching result. While updating, the previous completed rows and summaries remain explicitly marked, and page controls are disabled. CSV exports the current applied selections and sort, across all pages; tags follow the API's JSON-array CSV representation.

Copy or bookmark the browser address to share the applied query, including sorting, page size and later pages. Reload and fresh tabs restore the results view. Back and Forward restore controls (discarding unsent drafts), rows and whole-result summaries; pending requests retain the previous snapshot as stale. Details and export activity do not create history entries. Invalid address values fall back to defaults; invalid dates clear and reversed date ranges clear both bounds. Unknown parameters are removed.

Named views persist the applied search, facets, dates, sorting, and page size in browser localStorage. Opening a view applies its selections together and returns to page one. Storage failures are visible and exploration remains available.

The native details dialog supports keyboard dismissal, exposes every incident field as text, and restores focus to the incident on return. Results, detail sessions, and exports have separate ownership tokens. Each completion, error, and cleanup is gated; changed selections invalidate details and export downloads. Cancellation helps save work but tokens provide correctness. Download object URLs are released.

Run the repository's exact verification command from the checkout:

```sh
npm test
```

Discoverable tests under `tests/frontend/` exercise the actual DOM-free state module with direct events. These establish component behavior, including overlapping intents and retries; they do not establish real HTTP or browser integration. The integration suites run real sandbox-enabled Chromium against the existing backend and compare with an independent canonical-data oracle. See the root README for preparation, browser qualification and startup instructions.

Component review: `state.js` separates the requested intent from the last displayed snapshot and publishes rows and whole-result summaries atomically. Pending or stale queries lock pagination, and synchronous page transitions are clamped before dispatch. The UI retains the native modal and return target while detail ownership changes; it renders dataset values through text nodes. Independent operation tokens gate success, failure, and cleanup, and export gates download side effects after reading the response. This review establishes frontend structure and state behavior only.

Service comparison represents the entire applied filtered result, including later
pages. Incidents is the service's matching count; Unresolved includes open and
in-progress; Critical + high includes those severities in any status. Average
resolution hours uses opened-to-resolved elapsed time for resolved incidents only.
Unavailable means there are no resolved matches, not an average of zero. Services
sort by unresolved count descending, then name. Pagination, row count and sort do
not affect the measures. A selection label identifies previous versus current
measures; loading, empty and failure messages explain state, and Retry requests
the current selection. Overview operation tokens and filter signatures own its
results, errors and cleanup separately from the list and detail sessions.

Personal triage adds from full details without duplicates and preserves insertion
order. Each entry shows identifying incident information, a 2,000-character
plain-text note and Open details/Remove actions. Notes update as you type; markup
is literal text. Reopening retrieves details without changing search. Removing an
entry removes its note. The separate `incident-explorer.triage.v1` localStorage
key retains membership, snapshots and notes on same-origin reload. It is separate
from saved views and the address; nothing is written to canonical incidents or
sent to an external service. Browser clearing, a different hostname/port, or
another browser does not retain this list; there is no tab synchronization.
Malformed or inaccessible storage shows a warning and leaves a usable visit
list. Failed writes retain current visit edits, which may disappear on reload.

Use Enter on incident/detail actions and Escape or Close details to dismiss the
native dialog and restore focus. Visible focus and stacked phone service measures
and triage actions support keyboard and narrow-screen use. The combined
`tests/integration/overview-triage.test.mjs` independently reduces canonical data
for real HTTP, exercises real overview updates and server failure/retry, and
completes a same-origin persisted triage journey in sandbox-enabled Chromium.
Its production-module assertions cover storage fallback and interacting request,
error, announcement and cleanup ownership; existing regressions remain in place.

From the checkout, the unchanged preparation/probe/test sequence is:

```sh
npm run pretest
qualification-browser-smoke
npm test
```

For local use run `npm run seed`, then `npm run start`, open
http://127.0.0.1:3000 and stop the foreground server with Ctrl+C (or SIGTERM).
