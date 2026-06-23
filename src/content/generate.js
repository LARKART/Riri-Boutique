/**
 * AI content module (spec 5.2 invented name, 10 description; lifecycle Stage 6).
 *
 * Generates ORIGINAL copy from product attributes via the Claude API:
 *   - an invented, brand-style product name for after the pipe (never a
 *     competitor name or SKU code)
 *   - an original product description (structured sections, premium tone)
 *   - SEO title + description
 *
 * The keyword-first product TITLE is generated deterministically elsewhere
 * (src/transform/title.js); this module only produces the parts that require
 * natural language. Per spec 17, no competitor wording/branding is ever copied.
 *
 * SDK usage follows the Claude API reference: @anthropic-ai/sdk, model
 * claude-opus-4-8, structured output via output_config.format (json_schema),
 * adaptive thinking, and typed error handling.
 */

'use strict';

import Anthropic from '@anthropic-ai/sdk';
import { titleCore } from '../transform/title.js';

const MODEL = 'claude-opus-4-8';

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Invented brand-style product name for after the pipe.' },
    descriptionHtml: { type: 'string', description: 'Original product description as simple HTML.' },
    seoTitle: { type: 'string' },
    seoDescription: { type: 'string' },
  },
  required: ['name', 'descriptionHtml', 'seoTitle', 'seoDescription'],
};

const SYSTEM = `You write original e-commerce copy for a premium women's fashion boutique (Riri Boutique).
Rules you must follow exactly:
- The product's NAME is provided to you as "productName". Use that EXACT name wherever you refer to the product by name in the description, seoTitle, and seoDescription. Never substitute, invent, abbreviate, or use any other name. Only if productName is null may you invent a short, clean, brand-style name (e.g. Serane, Elowen) that copies no competitor name, brand, or SKU code.
- Write copy for THIS product only, using only the data in this message. Do not reference any other product.
- Write an ORIGINAL description. Never copy competitor or supplier wording verbatim.
- Description sections, in order: a short benefit/style opening paragraph; a "Why you'll love it" list; fit / silhouette notes; occasion & styling suggestions; material/feel only if provided. Care/sizing notes only if known.
- Tone: clean, premium, conversion-focused, not exaggerated. No medical/body-shaping claims, no fake material claims, no keyword stuffing.
- Output descriptionHtml as simple, valid HTML (<p>, <ul>, <li>, <strong>). No colors in the product name.
- SEO title/description should be derived from the keyword-first title core; keep the SEO title under ~60 chars and the SEO description under ~155 chars.`;

/**
 * @param {object} draft canonical product draft
 * @param {Anthropic} [client] injectable client (defaults to env-configured)
 * @returns {Promise<{name,descriptionHtml,seo:{title,description}}>}
 */
export async function generateContent(draft, client = new Anthropic()) {
  const core = titleCore(draft); // colorless keyword title core, for SEO grounding
  const productName = draft.name || null; // authoritative name decided up front

  // Each call is a fresh, stateless request scoped to a single product — no
  // history is carried between products in a batch (prevents name carryover).
  const userPayload = {
    productName,
    keywordTitleCore: core,
    productType: draft.productType,
    isDress: draft.isDress,
    attributes: draft.attributes || {},
    factualHints: draft.descriptionInput || {},
  };

  const nameDirective = productName
    ? `This product's name is exactly "${productName}". Use this exact name (and no other) wherever the product is named in descriptionHtml, seoTitle, and seoDescription.\n\n`
    : 'Invent a unique brand-style name and use it consistently across all fields.\n\n';

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            nameDirective +
            'Generate the name, descriptionHtml, seoTitle, and seoDescription for this product. ' +
            'Base the copy only on the data provided; do not invent unverifiable claims.\n\n' +
            JSON.stringify(userPayload, null, 2),
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error('Claude API auth failed — check ANTHROPIC_API_KEY.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error('Claude API rate limited — retry with backoff.');
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Claude API error ${err.status}: ${err.message}`);
    }
    throw err;
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to generate content for this product (refusal).');
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude response contained no text block.');

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error(`Claude returned non-JSON content: ${textBlock.text.slice(0, 300)}`);
  }

  // The decided name always wins; the model only fills it in when none was given.
  return {
    name: productName || parsed.name,
    descriptionHtml: parsed.descriptionHtml,
    seo: { title: parsed.seoTitle, description: parsed.seoDescription },
  };
}

export { MODEL, OUTPUT_SCHEMA };
