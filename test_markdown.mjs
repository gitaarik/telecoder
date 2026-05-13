import { convert } from 'telegram-markdown-v2';

// Your original problematic text (already has escaping from your message)
const testText = `| { name: string; role: "literal"; value: string } // e.g. { name: "origin", value: "JOBS_HOME_SEARCH_BUTTON" }
  | {                                                // e.g. { name: "f_WT", canonical: "work_location", values: { remote: "2" } }
      name: string;
      role: "filter";
      canonical: SearchFilterName;
      multi: boolean;
      sep?: string;                                  // only for multi
      values: Record<string, string>;                // canonical option_key → URL value
    };

type Preset = {
  base_url: string;                                  // path included, no query string
  search_params: SearchParam[];
  // ...existing fields kept
};

A LinkedIn preset would look like:

{
  "base_url": "https://www.linkedin.com/jobs/search-results/",
  "search_params": [
    { "name": "keywords", "role": "keywords" },
    { "name": "origin", "role": "literal", "value": "JOBS_HOME_SEARCH_BUTTON" },
    { "name": "f_WT", "role": "filter", "canonical": "work_location", "multi": false, "values": { "remote": "2", "onsite": "1", "hybrid": "3" } }
  ]
}

That's self-describing, validatable, and easy for the import UI to consume.

*The refactor surface:*

1. Schema migration to job_platform_search_presets: add base_url text + search_params jsonb; keep url_template and params for backwards compat until everything's migrated.
2. Discovery: emit search_params directly. Doing so forces us to compute _the_ param-name + value per filter option, which naturally fixes the per-option pollution from problem 1 above (the cross-option diff that's missing today).
3. URL building (fillSearchTemplate → new \`buildSearchUrl(base_url, search_params, user_inputs)\`) — much simpler than the current placeholder dance.
4. Admin approval UI: render one card per param (role badge, name, values), diffed against current preset (already wired for filter params).
5. One-off migration script that parses existing presets into the new shape.
6. Drop the legacy columns once everything reads from the new ones.

*Questions before I start*

1. *Migrate existing presets or drop?* There are existing preset rows in production. Easiest: write a parser that turns \`url_template\` + params into \`search_params\`. If you'd rather just drop and re-discover, that's faster but loses your manual edits.
2. *Sort order for \`search_params\` matters* because the URL is built in array order. Discovery should emit keywords/location first, then filters by canonical taxonomy order, then literals last. Sound right?
3. *Cross-option diff for filter params*: when discovery probes filter options, the new shape forces us to compute "which single param key is this filter's name, which value does each option map to". I'd implement this by collecting all probed-option URL diffs for a widget, finding the param key whose value differs between options, and treating the rest as ephemeral. Multi-select widgets need slightly different handling. OK to implement that as part of this refactor?
4. *LLM mis-identification* (LinkedIn calling salary buttons "work_location"): separate problem — needs a prompt improvement or post-click validation. Tackle that in this refactor or as a follow-up?

If 1–3 sound good and you have a preference on 4, I'll start the refactor. I'd estimate it as: 1 small schema migration, 2 medium discovery changes (output shape + cross-option diff), 1 medium URL-builder rewrite, 1 medium admin UI update, plus the parser script.`;

try {
  console.log('=== Testing telegram-markdown-v2 conversion ===');
  const result = convert(testText, 'escape');
  console.log('SUCCESS:');
  console.log(result.substring(0, 800) + '\n...\n');

  console.log('Full length check:');
  console.log('Original length:', testText.length);
  console.log('Converted length:', result.length);

} catch (error) {
  console.log('ERROR:', error.message);
  console.log('STACK:', error.stack);
}