# Netflix adapter evidence

Inspection date: 5 November 2026, logged-in desktop Chrome browse interface. No cookies, credentials or session files were exported.

Observed modern card: `a[data-uia="standard-card"][aria-label]` with `/browse?jbv=<title-id>`. Image alternative text can be empty, so card identity uses its explicit accessible label. Hashed class names are excluded. Watch URLs can point to episodes and are rejected as source title IDs.

Observed detail modal: `[data-uia="modal-motion-container-DETAIL_MODAL"]`; scoped `[data-uia="previewModal--detailsMetadata"]`. The user-opened series panel had an Episodes heading and a later season date, so the adapter learns series type only. It never compares that date to IMDb series start year.

An inspected movie supplied `.videoMetadata--line > .year` and `span.duration` within `[data-uia="videoMetadata--container"]`, plus explicit `This Movie Is:` metadata. Enrichment requires a matching scoped title image label and current source ID. English copy is a known coverage limit. Detail-page redirects and alternative layouts may prevent enrichment.

The v1 overlay is a fixed sibling of site content. It does not nest an interactive control in a streaming link, alter parent positioning styles or open details on the user's behalf during normal browsing. It hides at clip boundaries, when obscured and on unsupported navigation.

The real markup inspection does not establish that injected controls pass Netflix's capture-listener/playback, search, My List, focus or zoom acceptance. Those checks remain explicit in the installation guide. Automated fixtures verify the adapter/controller mechanics with labelled fake data.
