'use strict';

/**
 * Tenant Profile Schema (v1)
 *
 * Zod schema for the JSONB blob stored in `tenant_profiles.profile`. The single
 * source of truth for everything "true about a tenant" — identity, offer, ICP,
 * proof, voice, constraints, documents.
 *
 * Spec: MJxClaude/projects/beavrdam-rebuild/tenant-profile-schema-v1.md
 * Migration: server/db/migrations/072_tenant_profile.sql
 *
 * Two parsing modes:
 *   - `profileSchema.parse(...)`          — base shape check (used on every save)
 *   - `profileActivationSchema.parse(...)` — adds activation-time gates
 *                                            (voice.examples.good >= 3,
 *                                             voice.examples.bad >= 2)
 *
 * The base schema is permissive on examples (any length) so a draft can be
 * saved incrementally. Activation rejects below the floor.
 */

const { z } = require('zod');

// ── identity ─────────────────────────────────────────────────────────────
const identitySchema = z.object({
  company: z.string().min(1),
  founder: z.object({
    name: z.string().min(1),
    role: z.string().min(1),
    linkedin_url: z.string().url().optional().nullable(),
  }),
  sender_persona: z.object({
    name: z.string().min(1),
    title: z.string().min(1),
    email: z.string().email().optional().nullable(),
    signature_image_uri: z.string().optional().nullable(),
  }),
  brand_voice: z.string().min(1),
});

// ── offer ────────────────────────────────────────────────────────────────
const offerSchema = z.object({
  product: z.string().min(1),
  services: z.array(z.string()).default([]),
  pricing: z.object({
    tiers: z.array(z.object({
      name: z.string(),
      price: z.string(),
      terms: z.string().optional().nullable(),
    })).default([]),
    notes: z.string().optional().nullable(),
  }).default({ tiers: [] }),
  positioning: z.string().min(1),
});

// ── icp ──────────────────────────────────────────────────────────────────
const icpSchema = z.object({
  verticals: z.array(z.string()).default([]),
  personas: z.array(z.string()).default([]),
  geo: z.array(z.string()).default([]),
  exclusions: z.array(z.string()).default([]),
  competitor_offers: z.array(z.string()).default([]),
});

// ── proof ────────────────────────────────────────────────────────────────
// Every entry starts approved_for_outreach=false. MJ flips manually. Beavers
// may only cite when true. Source MUST be specified — protects against
// citing confidential or never-approved results.
const proofItemSchema = z.object({
  claim: z.string().min(1),
  metric: z.string().min(1),
  source: z.string().min(1),
  approved_for_outreach: z.boolean().default(false),
});

// ── voice ────────────────────────────────────────────────────────────────
// Soft guidance, prompt-injected. NOT validated post-hoc (constraints handles
// the machine-checkable rules). examples.good/bad are few-shot anchors —
// activation requires >= 3 good / >= 2 bad.
const voiceSchema = z.object({
  tone: z.array(z.string()).default([]),
  do: z.array(z.string()).default([]),
  dont: z.array(z.string()).default([]),
  examples: z.object({
    good: z.array(z.string()).default([]),
    bad: z.array(z.string()).default([]),
  }).default({ good: [], bad: [] }),
});

// ── constraints ──────────────────────────────────────────────────────────
// Machine-checkable. Enforcer validates against these programmatically after
// generation. Send-gate re-validates against current content_version at send
// time (handles drift between draft and send).
const channelKey = z.enum(['email', 'linkedin_dm', 'linkedin_invite']);
const constraintsSchema = z.object({
  word_cap_by_channel: z.record(channelKey, z.number().int().positive()).default({}),
  banned_phrases: z.array(z.string()).default([]),
  signoff_by_channel: z.record(channelKey, z.string().nullable()).default({}),
  max_links: z.number().int().nonnegative().default(1),
  allow_emoji: z.boolean().default(false),
});

// ── documents ────────────────────────────────────────────────────────────
// Ship-the-seam-skip-the-infra. v1: every entry indexed=false. Summary
// alone is enough to inject. RAG flipped on later when summaries stop
// fitting in context.
const documentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  type: z.enum(['case_study', 'brand_guide', 'transcript', 'policy', 'other']),
  summary: z.string().min(1),
  uri: z.string().min(1),
  indexed: z.boolean().default(false),
});

// ── full profile (base — used on every save) ─────────────────────────────
const profileSchema = z.object({
  identity:    identitySchema,
  offer:       offerSchema,
  icp:         icpSchema,
  proof:       z.array(proofItemSchema).default([]),
  voice:       voiceSchema,
  constraints: constraintsSchema,
  documents:   z.array(documentSchema).default([]),
}).strict();

// ── activation gate (adds floors on voice.examples) ──────────────────────
// Activation-only. Draft saves use profileSchema; flipping status to 'active'
// runs profileActivationSchema and rejects below the example floors.
const profileActivationSchema = profileSchema.superRefine((data, ctx) => {
  if ((data.voice?.examples?.good?.length || 0) < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_small,
      type: 'array',
      minimum: 3,
      inclusive: true,
      path: ['voice', 'examples', 'good'],
      message: `Activation requires at least 3 good examples (current: ${data.voice?.examples?.good?.length || 0})`,
    });
  }
  if ((data.voice?.examples?.bad?.length || 0) < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_small,
      type: 'array',
      minimum: 2,
      inclusive: true,
      path: ['voice', 'examples', 'bad'],
      message: `Activation requires at least 2 bad examples (current: ${data.voice?.examples?.bad?.length || 0})`,
    });
  }
});

module.exports = {
  profileSchema,
  profileActivationSchema,
  // Section exports for reuse in UI / tests
  identitySchema,
  offerSchema,
  icpSchema,
  proofItemSchema,
  voiceSchema,
  constraintsSchema,
  documentSchema,
};
