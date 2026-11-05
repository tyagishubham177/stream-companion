# Netflix adapter evidence

Inspection date: 5 November 2026, logged-in desktop Chrome browse interface. No cookies, credentials or session files were exported.

Observed modern card: `a[data-uia="standard-card"][aria-label]` with `/browse?jbv=<title-id>`. Image alternative text can be empty, so card identity uses its explicit accessible label. Hashed class names are excluded. Watch URLs can point to episodes and are rejected as source title IDs.

Version 0.2 also supports the inspected `a[data-uia="progress-card"][aria-label]` variant used by Continue Watching. These links expose whole-title `jbv` IDs and use the same separate overlay and visibility rules. The browser fixture includes this variant and a duplicate title so coverage and shared requests are verified together.

Observed detail modal: `[data-uia="modal-motion-container-DETAIL_MODAL"]`; scoped `[data-uia="previewModal--detailsMetadata"]`. The user-opened series panel had an Episodes heading and a later season date, so the adapter learns series type only. It never compares that date to IMDb series start year.

An inspected movie supplied `.videoMetadata--line > .year` and `span.duration` within `[data-uia="videoMetadata--container"]`, plus explicit `This Movie Is:` metadata. Enrichment requires a matching scoped title image label and current source ID. English copy is a known coverage limit. Detail-page redirects and alternative layouts may prevent enrichment.

Version 0.2.1 anchors each badge in a shadow host beside its title link, inside the inspected plain card-sized DIV wrapper. Native layout handles scrolling, carousel transforms and ancestor clipping; there is no per-scroll badge measurement or coordinate update. Unexpected interactive or mismatched wrappers fail closed. Static wrappers receive `position: relative`; cleanup restores only that owned property if the site has not changed it. Existing Netflix wrappers are already positioned. The shared details panel stays outside site content and dismisses on page/carousel scrolling without moving focus. Explicit Close/Escape returns focus to the badge. Controls never nest inside streaming links or open Netflix details during normal browsing.

The real markup inspection does not establish that injected controls pass Netflix's capture-listener/playback, search, My List, focus or zoom acceptance. Those checks remain explicit in the installation guide. Automated fixtures verify the adapter/controller mechanics with labelled fake data.

Version 0.2.2 includes expanded hover previews using the exact `modal-motion-container-MINI_MODAL` hook. The preview itself is a noninteractive dialog container; its player artwork label and unique `/title/:id` link identify the work. `/watch/:id` is never used because the inspected preview played an episode with a different ID. The preview badge uses the upper left, clear of native close/logo controls. Missing/conflicting title links or artwork labels fail closed, and recycling invalidates the old score. Fresh identical card observations share their displayed rating immediately.
