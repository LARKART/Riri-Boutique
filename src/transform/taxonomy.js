/**
 * Taxonomy resolver (spec 6.1 / 6.2; lifecycle Stage 5).
 *
 * Dresses     -> fixed taxonomy category aa-1-4 (Apparel > Clothing > Dresses).
 *                Never use Bridal taxonomy unless the product is a bridal gown.
 * Non-dresses -> dynamic lookup against Shopify's taxonomy by product type.
 *                Never hardcode/guess categories for non-dresses.
 */

'use strict';

import { shopifyGraphQL } from '../shopify/client.js';

export const DRESS_CATEGORY_GID = 'gid://shopify/TaxonomyCategory/aa-1-4';
export const OUTFIT_SETS_CATEGORY_GID = 'gid://shopify/TaxonomyCategory/aa-1-11';

const TAXONOMY_SEARCH = `
  query TaxonomySearch($q: String!) {
    taxonomy {
      categories(search: $q, first: 5) {
        nodes { id fullName isLeaf }
      }
    }
  }
`;

/**
 * Resolve the Shopify taxonomy category GID for a product draft.
 * @param {{isDress: boolean, productType: string}} draft
 * @param {(q:string,v?:object)=>Promise<object>} [gql] injectable for testing
 * @returns {Promise<{id: string, fullName?: string}>}
 */
export async function resolveCategory(draft, gql = shopifyGraphQL) {
  if (draft.isDress) {
    return { id: DRESS_CATEGORY_GID, fullName: 'Apparel & Accessories > Clothing > Dresses' };
  }
  // Two-piece outfits / sets (and rompers grouped with them) use Outfit Sets,
  // never the Dresses category.
  if (draft.isSet) {
    return { id: OUTFIT_SETS_CATEGORY_GID, fullName: 'Apparel & Accessories > Clothing > Outfit Sets' };
  }

  const q = String(draft.productType || '').trim();
  if (!q) throw new Error('Cannot resolve taxonomy: non-dress product has no productType.');

  const data = await gql(TAXONOMY_SEARCH, { q });
  const nodes = data?.taxonomy?.categories?.nodes || [];
  if (nodes.length === 0) {
    throw new Error(`No Shopify taxonomy category found for product type "${q}". ` +
                    `Refine productType; categories are never guessed for non-dresses.`);
  }
  // Prefer a leaf category; otherwise take the first (best) match.
  const chosen = nodes.find((n) => n.isLeaf) || nodes[0];
  return { id: chosen.id, fullName: chosen.fullName, candidates: nodes };
}
