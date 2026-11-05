# Privacy

Stream Companion sends lookup title names, corresponding release years, media types or IMDb IDs to `https://www.omdbapi.com/`. The OMDb key accompanies provider requests. OMDb also receives normal connection metadata such as IP address.

For automatic identity matching, the public Netflix IDs of visible titles are sent in small batches to `https://query.wikidata.org/sparql`. Wikidata returns community-maintained Netflix-to-IMDb identifier links and receives normal connection metadata. It never receives the OMDb key, streaming credentials, cookies, account/profile identifiers or playback history. Saved mappings and fresh caches avoid repeating these queries on every visit.

When a direct ID relationship is missing for a film, the worker requests its public Netflix title page from `https://www.netflix.com/in/title/:id`. This fixed public India/English catalogue route does not read or change the Netflix account’s region. Requests omit cookies, authentication and referrers, and never include the OMDb key. Netflix receives the public title ID and normal connection metadata. Only the film name, movie type and visibly displayed release year are extracted; scripts and private application state are not executed or read. Accepted metadata is cached locally for 30 days, genuine unsupported/missing pages for one day. It is not collected for off-screen browsing history.

Preferences, saved mappings, provider key, request accounting and metadata cache stay in this browser profile. The key is restricted to trusted extension contexts and never returned to page scripts or diagnostics. The extension does not use streaming account/profile IDs, cookies, private endpoints, viewing-history events or analytics.

Local title mappings and caches contain title metadata and matching provenance. Diagnostics use aggregate counts and settings only, excluding title records, raw URLs, credential fingerprints and keys. Opening IMDb, OMDb or Wikidata links deliberately visits those sites under their own privacy practices.

Clear ratings cache, reset saved matches and remove key are independent actions. Request usage/cooldowns remain after these operations to preserve conservative accounting. Uninstalling the extension removes extension-managed browser data; its local estimate cannot account for a key used elsewhere or data lost by uninstall/profile reset.
