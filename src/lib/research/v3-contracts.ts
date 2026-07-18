/**
 * Research OS v3 contract helpers and profile persistence intent.
 */

import { composeProfile, validateCompositionForRun } from "./archetypes/compose";
import type { ComposedProfile, ArchetypeCompositionError } from "./archetypes/types";

export type ProfileSelectionIntent = {
  asset_id: string;
  archetypes: string[];
  overlays: string[];
  human_override?: {
    overridden_by: string;
    reason: string;
  };
  timing_hypothesis?: {
    hypothesis_text: string;
    accepted: boolean;
    accepted_at: string;
    accepted_by: string;
  };
};

export type ProfileSelectionResult = {
  profile_id: string;
  composed: ComposedProfile;
  errors: ArchetypeCompositionError[];
  valid: boolean;
};

export function createV3Profile(
  profileId: string,
  intent: ProfileSelectionIntent
): ProfileSelectionResult {
  const { profile, errors } = composeProfile(
    profileId,
    intent.asset_id,
    intent.archetypes,
    intent.overlays,
    intent.timing_hypothesis
  );

  const valid = errors.length === 0 || errors.every((e) => e.code !== "conflict");

  return { profile_id: profileId, composed: profile, errors, valid };
}

export function validateV3Archetypes(
  archetypes: string[],
  overlays: string[] = []
): ArchetypeCompositionError[] {
  return validateCompositionForRun(archetypes, overlays);
}

export function isBacktestApplicable(
  timingHypothesis?: ProfileSelectionIntent["timing_hypothesis"]
): "not_applicable" | "pending" | "completed" | "failed" {
  if (!timingHypothesis || !timingHypothesis.accepted) return "not_applicable";
  return "pending";
}

export { composeProfile };
export type { ComposedProfile, ArchetypeCompositionError } from "./archetypes/types";
