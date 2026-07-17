// Stage 3 — Gap enrichment (budget-gated) + finalization.
//
// 1. For rows still missing email/LinkedIn after Stage 2, query Apollo.io
//    first (larger free allowance; also returns LinkedIn + titles), then
//    Hunter.io (small free quota — reserved for remaining gaps). Both are
//    optional: set APOLLO_API_KEY / HUNTER_API_KEY in .env, or skip entirely.
//    Every enriched email records its source (apollo/hunter + domain).
// 2. For rows NOT seeded from SEC IAPD (discovery-mode finds), run an IAPD
//    name search as the legitimacy cross-check (Stage 5 of the spec).
// 3. Compute needs_review per the spec: false only when the firm is
//    SEC-verified AND has a confirmed US city/state AND a sourced email.
//
// Output: data/stage3-verified.jsonl

import { readJsonl, appendJsonl, fetchJson, sleep, logRun, bumpMonthlyUsage } from './util.js';

const APOLLO_MONTHLY_LIMIT = Number(process.env.APOLLO_MONTHLY_BUDGET || 10000);

const APIFY_BASE = process.env.APIFY_BASE_URL || 'https://api.apify.com';
const APIFY_TOKEN = process.env.APIFY_API_TOKEN || '';
const APIFY_ACTOR = process.env.APIFY_LEADS_ACTOR_ID || '';
const APIFY_LEAD_BUDGET = Number(process.env.APIFY_MONTHLY_LEAD_BUDGET || 5000);
const APOLLO_KEY = process.env.APOLLO_API_KEY || '';
const HUNTER_KEY = process.env.HUNTER_API_KEY || '';
const HUNTER_BUDGET = Number(process.env.HUNTER_MONTHLY_BUDGET || 25); // free tier

const rows = await readJsonl('stage2-enriched.jsonl');
const done = new Set((await readJsonl('stage3-verified.jsonl')).map((c) => c.channelId));
console.log(`${rows.length} rows; ${done.size} already finalized`);
if (APIFY_TOKEN && !APIFY_ACTOR) console.log('⚠ APIFY_API_TOKEN set but APIFY_LEADS_ACTOR_ID missing — set it to the actor ID (username~actor-name) from the Apify store page');
if (!APIFY_TOKEN) console.log('APIFY_API_TOKEN not set — skipping Apify Leads Finder enrichment');
if (!APOLLO_KEY) console.log('APOLLO_API_KEY not set — skipping Apollo enrichment');
if (!HUNTER_KEY) console.log('HUNTER_API_KEY not set — skipping Hunter enrichment');

let hunterUsed = 0;

function domainOf(site) {
  try { return new URL(site).hostname.replace(/^www\./, ''); } catch { return null; }
}

// Apify "Leads Finder" enrichment (primary, $1.5/1k leads). Runs the actor
// synchronously against the firm's domain and returns the best contact.
// Actor input/output schemas vary between store actors — the field mapping
// below is defensive; if your actor uses different input keys, adjust INPUT_KEY.
async function apifyEnrich(domain, firmName) {
  const monthUsed = await bumpMonthlyUsage('apify_leads');
  if (monthUsed > APIFY_LEAD_BUDGET) {
    console.warn(`⚠ Apify: monthly lead budget reached (${monthUsed}/${APIFY_LEAD_BUDGET}) — skipping`);
    return null;
  }
  if (monthUsed > APIFY_LEAD_BUDGET * 0.8) {
    console.warn(`⚠ Apify: ${monthUsed}/${APIFY_LEAD_BUDGET} leads used this month (~$${(monthUsed * 1.5 / 1000).toFixed(2)})`);
  }
  try {
    const url = `${APIFY_BASE}/v2/acts/${encodeURIComponent(APIFY_ACTOR)}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=120&maxItems=5`;
    const items = await fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // code_crafter/leads-finder (Apollo-style) input: filter by company domain.
        company_domain: [domain],
      }),
    }, 1);
    if (!Array.isArray(items) || !items.length) return null;
    const pick = (it) => it.email || it.business_email || it.emailAddress || it.work_email || null;
    // Rank leads: firm-domain email first (spec: emails must come from the
    // official firm domain — never guessed), then decision-maker titles
    // (the "Advisor Name" we want is the founder/advisor, not e.g. an assistant).
    const DECIDER = /founder|owner|president|principal|advisor|adviser|partner|ceo|wealth|planner/i;
    const ranked = [...items].sort((a, b) => {
      const ae = (pick(a) || '').toLowerCase().endsWith('@' + domain) ? 1 : 0;
      const be = (pick(b) || '').toLowerCase().endsWith('@' + domain) ? 1 : 0;
      if (ae !== be) return be - ae;
      return (DECIDER.test(b.title || b.jobTitle || '') ? 1 : 0) - (DECIDER.test(a.title || a.jobTitle || '') ? 1 : 0);
    });
    const lead = ranked[0];
    const email = (pick(lead) || '').toLowerCase() || null;
    return {
      email: email && email.endsWith('@' + domain) ? email : null, // reject non-firm-domain emails
      emailRaw: email,
      emailSource: email ? `apify:${APIFY_ACTOR} (lead database, domain-matched)` : null,
      advisorName: lead.fullName || lead.full_name || lead.name
        || [lead.firstName || lead.first_name, lead.lastName || lead.last_name].filter(Boolean).join(' ') || null,
      phone: lead.phone || lead.mobile_number || lead.phoneNumber || lead.phone_number || null,
      linkedin: lead.linkedinUrl || lead.linkedin_url || lead.linkedin || null,
      title: lead.title || lead.jobTitle || lead.job_title || null,
      city: lead.city || lead.company_city || null,
      state: lead.state || lead.company_state || null,
    };
  } catch (err) {
    console.warn(`Apify enrich failed for ${domain}: ${err.message.slice(0, 120)}`);
    return null;
  }
}

// Apollo organization enrichment: free-tier friendly, keyed by domain.
async function apolloEnrich(domain) {
  try {
    const data = await fetchJson(
      `https://api.apollo.io/api/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
      { headers: { 'x-api-key': APOLLO_KEY, accept: 'application/json' } }, 1,
    );
    const org = data?.organization;
    if (!org) return null;
    return {
      phone: org.phone || org.primary_phone?.number || null,
      linkedin: org.linkedin_url || null,
      city: org.city || null,
      state: org.state || null,
    };
  } catch { return null; }
}

// Hunter domain search: returns generic + personal emails with sources.
async function hunterEnrich(domain) {
  if (hunterUsed >= HUNTER_BUDGET) return null;
  hunterUsed++;
  const hunterMonth = await bumpMonthlyUsage('hunter');
  if (hunterMonth > HUNTER_BUDGET * 0.8) {
    console.warn(`⚠ Hunter: ${hunterMonth}/${HUNTER_BUDGET} searches used this month`);
  }
  if (hunterMonth > HUNTER_BUDGET) return null; // monthly cap across runs, not just per-run
  try {
    const data = await fetchJson(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_KEY}&limit=3`,
      {}, 1,
    );
    const emails = data?.data?.emails || [];
    // Prefer emails Hunter itself found on a source page (verifiable), highest confidence first.
    const best = emails
      .filter((e) => (e.sources || []).length)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    if (!best) return null;
    return {
      email: best.value.toLowerCase(),
      emailSource: `hunter.io (source: ${best.sources[0].uri || best.sources[0].domain})`,
      firstName: best.first_name,
      lastName: best.last_name,
      linkedin: best.linkedin || null,
    };
  } catch { return null; }
}

// IAPD legitimacy check for non-seeded rows (free public search API).
async function iapdVerify(name) {
  const qs = new URLSearchParams({ query: name, nrows: '3', start: '0', wt: 'json' });
  for (const kind of ['firm', 'individual']) {
    try {
      const data = await fetchJson(`https://api.adviserinfo.sec.gov/search/${kind}?${qs}`, {
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; LeadResearchBot/1.0)' },
      }, 1);
      const hit = data?.hits?.hits?.[0]?._source;
      if (!hit) continue;
      const loc = hit.firm_main_office_location || hit.ind_current_employments?.[0]?.firm_main_office_location || '';
      const [city, state] = loc.split(',').map((s) => s.trim());
      return {
        kind,
        name: (hit.firm_name || `${hit.ind_firstname || ''} ${hit.ind_lastname || ''}`).trim(),
        crd: hit.firm_source_id || hit.ind_source_id || null,
        city: city || null,
        state: state || null,
      };
    } catch { return undefined; } // API unreachable — distinct from "no match" (null)
    finally { await sleep(400); }
  }
  return null;
}

for (const ch of rows) {
  if (done.has(ch.channelId)) continue;
  const out = { ...ch };
  const domain = ch.firmWebsite ? domainOf(ch.firmWebsite) : null;

  // --- Gap enrichment (only for rows that survived Stages 0–2 with gaps) ---
  // Primary: Apify Leads Finder (replaces Apollo/Hunter when configured).
  if (domain && APIFY_TOKEN && APIFY_ACTOR && (!out.email || !out.phone || !out.linkedin)) {
    const a = await apifyEnrich(domain, ch.seedFirm?.name || ch.title);
    if (a) {
      if (!out.email && a.email) { out.email = a.email; out.emailSource = a.emailSource; }
      out.phone = out.phone || a.phone;
      out.linkedin = out.linkedin || a.linkedin;
      out.advisorName = out.advisorName || a.advisorName;
      out.cityState = out.cityState || (a.city && a.state ? `${a.city}, ${a.state}` : null);
    }
    await sleep(500);
  }
  if (domain && APOLLO_KEY && (!out.phone || !out.linkedin || !out.cityState)) {
    const apolloMonth = await bumpMonthlyUsage('apollo');
    if (apolloMonth > APOLLO_MONTHLY_LIMIT * 0.9) {
      console.warn(`⚠ Apollo: ${apolloMonth} credits used this month (limit ~${APOLLO_MONTHLY_LIMIT})`);
    }
    const a = await apolloEnrich(domain);
    if (a) {
      out.phone = out.phone || a.phone;
      out.linkedin = out.linkedin || a.linkedin;
      out.cityState = out.cityState || (a.city && a.state ? `${a.city}, ${a.state}` : null);
    }
    await sleep(300);
  }
  if (domain && HUNTER_KEY && !out.email) {
    const h = await hunterEnrich(domain);
    if (h) {
      out.email = h.email;
      out.emailSource = h.emailSource;
      out.linkedin = out.linkedin || h.linkedin;
      if (h.firstName && h.lastName) out.advisorName = `${h.firstName} ${h.lastName}`;
    }
    await sleep(300);
  }

  // --- Legitimacy: seeded rows are pre-verified; discovery rows need IAPD ---
  let verified = false;
  if (ch.seedFirm?.crd) {
    verified = true;
    out.iapdMatch = { kind: 'firm', name: ch.seedFirm.name, crd: ch.seedFirm.crd };
  } else {
    const m = await iapdVerify(ch.title);
    if (m) {
      verified = true;
      out.iapdMatch = m;
      out.cityState = out.cityState || (m.city && m.state ? `${m.city}, ${m.state}` : null);
    } else {
      out.iapdMatch = null;
      if (m === undefined) out.verifyError = 'IAPD API unreachable';
    }
  }

  out.needs_review = !(verified && out.cityState && out.email && !out.verifyError);
  await appendJsonl('stage3-verified.jsonl', out);
  const flags = [verified ? 'SEC✓' : 'SEC✗', out.email ? 'email✓' : 'email✗', out.needs_review ? 'needs_review' : 'CLEAN'];
  console.log(`${ch.title} — ${flags.join(' ')}`);
}

const finals = await readJsonl('stage3-verified.jsonl');
await logRun('stage3-finalize', {
  totalRows: finals.length,
  verified: finals.filter((r) => !r.needs_review).length,
  hunterUsedThisRun: hunterUsed,
});
console.log(`Stage 3 complete → data/stage3-verified.jsonl (Hunter searches used: ${hunterUsed}/${HUNTER_BUDGET})`);
