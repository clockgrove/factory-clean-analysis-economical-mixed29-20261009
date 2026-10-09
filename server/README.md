# Local incident server

From the repository root, run `npm run seed`, then `npm run start`.
The server prints its actual URL, normally `http://127.0.0.1:3000`.
Set `PORT` to another port, or `PORT=0` for an available ephemeral port.
Press Ctrl+C to close it gracefully. Run `npm test` for verification.

The server reads `.runtime/incidents.json` without changing it and serves
the repository's `public/` directory when frontend files are present.
Only GET requests are supported. API errors are `{error:{code,message}}`.

`/api/incidents` accepts literal case-insensitive `q` over ID, title and
description; repeated `service`, `status` and `severity`; inclusive UTC
`from` and `to` dates in YYYY-MM-DD form; `sort=openedAt|severity`;
`direction=asc|desc`; a positive `page`; and `pageSize=25|50`.
Defaults are no filters, openedAt descending, page 1 and size 25.
Facet values are case-sensitive and use the dataset's exact enumerations.
Values within a facet are OR, and separate facets are AND.
Opened-date ties use ID ascending. Severity ties use openedAt descending,
then ID ascending. Page requests clamp to the available range.
Summaries cover all matches, with chronological UTC day buckets.

`/api/incidents/:id` returns every incident field, or 404.
`/api/export.csv` applies the same filters and sorting, ignores pagination,
and exports all fields in dataset order. Tags are JSON array text, null is
empty, quotes are doubled, and records use CRLF.

`/api/overview` accepts the same query meanings as `/api/incidents` and returns
`{services:[{service,incidentCount,unresolvedCount,highSeverityCount,averageResolutionHours}]}`.
Every measure uses the whole filtered result; page, page size and sorting do not
change it. Unresolved means open or in-progress; high severity means critical or
high. Average resolution hours is elapsed opened-to-resolved time averaged only
across resolved incidents. No resolved matches produce null (shown as Unavailable),
and no matches produce an empty services array. Services sort by unresolved count
descending, then service name ascending. The endpoint is read-only; personal
triage and notes stay in browser storage and are never sent to it.

In the supplied qualification environment, run from the checkout in order:

```sh
npm run pretest
qualification-browser-smoke
npm test
```

Preparation checks the canonical data and pinned tooling; the probe verifies real
sandbox-enabled Chromium and loopback HTTP. Discoverable integration tests use
actual application HTTP and Chromium, including the finite `npm run start` proof,
and close their servers, browsers and subprocesses. The normal startup URL is
http://127.0.0.1:3000; Ctrl+C or SIGTERM shuts down the foreground server.
