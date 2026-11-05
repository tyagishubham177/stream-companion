# Privacy

Stream Companion sends lookup title names, corresponding release years, media types or IMDb IDs to `https://www.omdbapi.com/`. The OMDb key accompanies provider requests. OMDb also receives normal connection metadata such as IP address. No other production network destination is used for lookup.

Preferences, saved mappings, provider key, request accounting and metadata cache stay in this browser profile. The key is restricted to trusted extension contexts and never returned to page scripts or diagnostics. The extension does not use streaming account/profile IDs, cookies, private endpoints, viewing-history events or analytics.

Local title mappings and caches contain title metadata. Diagnostics use aggregate counts and settings only, excluding title records, raw URLs, credential fingerprints and keys. Opening IMDb or OMDb links deliberately visits those sites under their own privacy practices.

Clear ratings cache, reset saved matches and remove key are independent actions. Request usage/cooldowns remain after these operations to preserve conservative accounting. Uninstalling the extension removes extension-managed browser data; its local estimate cannot account for a key used elsewhere or data lost by uninstall/profile reset.
