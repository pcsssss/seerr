# TV download diagnostics (experimental fork)

Branch: `feature/tv-download-diagnostics`. The instructions below include isolated staging verification; deployment is a separate operation.

## Using the feature

On a TV detail page, administrators and users with **Manage Requests** can expand **Show download details**, just above Seasons. Ordinary requesters cannot access either the UI or API.

Choose Standard / 4K and, when needed, a request-specific mapping. The current media mapping uses its configured Sonarr server, including server ID zero. An explicit request uses its configured server, including server ID zero; null/undefined request overrides retain the version's media mapping. A missing mapped server never silently falls back. Series are resolved by exact TVDB ID on that server, rather than trusting a stale Sonarr series ID.

The panel displays each season's imported count, episode monitoring, visible queue items, percentage downloaded, Sonarr states/messages and recent episode history. Imported means Sonarr has a file, not that Plex/Jellyfin has scanned it. `No file / no visible queue` is not a diagnosis of rejection or lack of search results. A warning with no messages is reported as an unexplained Sonarr warning, not a fabricated cause.

Choose a season and click **Find sources**, or click **Find releases** beside an episode. An accessible source picker opens immediately, showing loading, any safe error, an empty state or the matching sources without scrolling past episode history. **Search again** retries the same target. **Close** (or Escape) cancels a pending search; canceled/stale responses cannot replace another season or episode's results.

The search explicitly asks Sonarr to query its indexers; it does not automatically download anything. Only releases with verified mappings to the selected series/season (and episode for an episode search) are displayed, filtered **before** the 100-result cap. Results include quality, indexer, size, protocol, seeders, mapped episode coverage, clearly marked season packs/episode releases and rejection reasons. Disallowed releases cannot be selected. **Select release** changes the same dialog to confirmation, avoiding stacked modals. Rejected releases and possible duplicates require separate acknowledgments. **Back to sources** does not download. **Download through Sonarr** submits its cached `guid`/`indexerId` identity, never a client-provided URL. Selections expire after five minutes; expiry clears confirmation, disables selection and offers a fresh search. Success is reported next to the season controls.


An existing download is **not canceled** when selecting another source. If a duplicate appears after search, the backend refuses an unacknowledged grab; refresh and search again to review it.

## Industry acceptance fixture

The user-provided live diagnostic snapshot (not fetched by the implementation) is:

- TVDB ID 371796, Sonarr series ID 15.
- Season 1: 8/8 files.
- Season 2: 0/8 files; all monitored. One already-grabbed season pack at approximately 1.8%, with a warning and no status messages.
- Season 3: episode **8** imported, episodes 1–7 missing and monitored. Do not label the imported file episode 1.

The intended display distinguishes S2's queue state from S3's missing episodes. Only an explicit search can establish today's available sources and rejection reasons. It cannot reconstruct old search decisions.

## Security and operational bounds

- Existing Seerr authentication, Manage Requests permission, OpenAPI validation and CSRF/session behavior apply. No Sonarr credentials are sent to the browser.
- Backend validates safe integer IDs and exact season/episode ownership. Clients cannot submit a server address, arbitrary release body, download URL or override episode mapping.
- Five-minute, random server-memory tokens bind the acting user, TMDB series, server configuration, Sonarr series, Standard/4K, optional request, season, episode and verified release identity. A token is one-use, including on uncertain upstream failure. Restarting Seerr invalidates tokens; multiple replicas need sticky routing.
- At most 500 release tokens are retained. Searches return at most 100 releases. Search is limited to five operations per minute per IP; download endpoints have a 60/minute per-IP limit.
- Sonarr responses are capped at 4 MiB. Free-text fields are capped at 500 characters; queue message groups and rejection reasons are capped at 20. Selectable releases must map at most 1000 known episodes and have an identity at most 4096 characters. Regular calls time out after 15 seconds, interactive search after 45 seconds. History scans at most three 100-record pages, each with a 10-second timeout, and returns at most ten events per episode. Queue reads at most 1000 records. Truncation is disclosed; search/grab is refused if the queue is incomplete because duplicates cannot be verified reliably.
- History is explicitly filtered by episode IDs and series IDs because some Sonarr versions ignore the history series query. Only allowlisted event date/type/title fields and a sanitized `data.message` (when supplied by Sonarr) are returned. URLs, complete Bearer/Basic authorization values, quoted credential assignments and filesystem paths in free text are redacted. Ambiguous path-bearing text may be omitted conservatively. Raw history `data`, file paths, download URLs, magnets and release GUIDs are never returned.
- A search/grab is not a promise of successful download or import. Sonarr may expire its own search cache sooner or reject the operation. After a grab timeout, check queue/progress before searching and retrying; the original operation may already have succeeded.

## Separate staging deployment (do not replace production)

First perform an independent review and use sandbox Sonarr/indexers/download clients. The feature deliberately has a real mutation endpoint; Manage Requests is not a read-only role.

From this checkout, after installing the required Node 22 / pnpm 10 versions:

```sh
pnpm install --frozen-lockfile
pnpm test server/lib/tvDownloads.test.ts server/api/servarr/sonarrDownloads.test.ts server/routes/tvDownloads.test.ts
pnpm typecheck
pnpm build
# Builds a distinct image; does not modify an existing container.
docker build --build-arg COMMIT_TAG=tv-diagnostics-local -t seerr-tv-diagnostics:local .
```

Example staging Compose file, kept outside the production media-center directory:

```yaml
services:
  seerr-tv-diagnostics:
    image: seerr-tv-diagnostics:local
    ports:
      - '127.0.0.1:5056:5055'
    volumes:
      - seerr-tv-diagnostics-config:/app/config
    environment:
      TZ: UTC
volumes:
  seerr-tv-diagnostics-config:
```

Run only that separate file/project, e.g. `docker compose -p seerr-tv-diagnostics -f staging.compose.yaml up -d`. Initialize fresh settings/database via `http://localhost:5056`; use separate sandbox service connections and an administrator account. Do not mount the production config, restore a production database into a shared volume, join production services automatically, or reuse port 5055. Notifications, jobs and request automation in copied settings can cause unintended activity. If a sanitized database snapshot is later needed for Industry testing, stop staging and restore into **its own** volume only after reviewing/disabling all integrations and automation.

Connecting staging to production Sonarr requires a separate explicit approval and a full review of side effects: Seerr background jobs and request workflows may mutate it independently of this new panel. A read-only mock/sandbox is the safe first validation path. Do not click Download against a live service during read-only diagnosis.

Before deployment, verify desktop/mobile layout, administrator and ordinary-user behavior, Standard/4K/request mapping, Industry episode numbering, unexplained warnings, empty results, rejected releases, season packs, duplicate confirmations, token expiry, and import errors using mocked or sandbox data. Only then decide on replacing production Seerr in a separately approved change.

## Isolated browser regression verification

After `pnpm build`, run these in two terminals from this checkout:

```sh
node cypress/mock-tv-downloads.mts
pnpm exec cypress run --config-file cypress.tv-downloads.config.ts
```

The mock server binds only `127.0.0.1:15056` and serves the **actual production Next TV page** with synthetic settings, user and Industry-shaped episode data. It never starts Seerr's server, database or background jobs, reads production configuration, or calls Sonarr. Server-side outbound HTTP is restricted to this exact loopback endpoint; browser tests reject non-mock origins and intercept all grab requests. Unintercepted grabs fail closed even in the mock. Stop the mock process after testing.

The regression spec exercises immediate in-viewport source-picker opening, slow search loading, S2 packs and episode results, failure/empty/retry, canceled searches followed by a new S3E1 target, expiry/retry, a single dialog changing to confirmation, focus restoration, separate rejection/duplicate acknowledgments and one simulated submit at 1440×1000 and 390×844. Native keyboard verification also checks Tab cycling inside the portal. It also verifies ordinary users render the TV page without diagnostics requests. Unhandled browser exceptions fail the tests. Confirmation screenshots are written to the ignored `cypress/screenshots` directory. This verifies frontend runtime behavior, not real Sonarr downloads/imports or every mobile browser.

## Residual limitations

This TV-only first slice does not persist diagnostic snapshots or past search decisions, cancel/retry existing torrents, tune quality profiles, repair imports, expose indexer health globally, or support arbitrary/manual episode mapping for ambiguous/anime releases. It does not poll automatically: use Refresh progress. History and queue are intentionally bounded. Sonarr API v3 mapped-episode metadata is required for selecting releases. Translated catalogs do not yet include the new message IDs; react-intl falls back to English defaults. Mock browser runtime and desktop/mobile confirmation checks are covered by the isolated Cypress spec. Real Sonarr download/import validation and independent acceptance review remain staging/reviewer tasks.
