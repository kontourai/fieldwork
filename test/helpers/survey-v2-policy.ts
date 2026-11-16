import assert from "node:assert/strict";
import { buildTrustReport, validateTrustBundle } from "@kontourai/surface";

/** Exercise the policy and review attestation Survey 9 actually writes. */
export function assertSurveyV2Verification(input: unknown): void {
  const bundle = validateTrustBundle(input as never);
  const policy = bundle.policies.find((entry) => entry.id === "survey.review-outcome.v1");
  assert.ok(policy, "Survey review policy must be carried");
  assert.deepEqual(policy.requiredMethods, ["attestation"]);
  const report = buildTrustReport(bundle);
  const verified = bundle.claims.filter((claim) => claim.status === "verified");
  assert.ok(verified.length, "fixture must exercise at least one verified claim");
  for (const claim of verified) {
    assert.equal(claim.verificationPolicyId, policy.id);
    const attestation = bundle.evidence.filter((entry) => entry.claimId === claim.id && entry.method === "attestation");
    assert.equal(attestation.length, 1, `one Survey attestation for ${claim.id}`);
    const survey = claim.metadata?.survey as { reviewOutcomeId?: string } | undefined;
    assert.equal(typeof survey?.reviewOutcomeId, "string");
    assert.equal(attestation[0]!.sourceRef, `survey:review-outcome:${survey!.reviewOutcomeId}`);
    assert.equal(attestation[0]!.metadata?.reviewOutcomeId, survey!.reviewOutcomeId);
    assert.ok(bundle.events.some((event) => event.claimId === claim.id && event.status === "verified"
      && event.actor === attestation[0]!.collectedBy && event.createdAt === attestation[0]!.observedAt
      && event.evidenceIds?.includes(attestation[0]!.id)), `event must cite the attestation for ${claim.id}`);
    assert.equal(report.claims.find((entry) => entry.id === claim.id)?.status, "verified");
    const withoutPolicy = buildTrustReport({ ...bundle, policies: bundle.policies.filter((entry) => entry.id !== policy.id) });
    const withoutAttestation = buildTrustReport({ ...bundle, evidence: bundle.evidence.filter((entry) => entry.id !== attestation[0]!.id) });
    assert.notEqual(withoutPolicy.claims.find((entry) => entry.id === claim.id)?.status, "verified", "policy removal must remove verification");
    assert.notEqual(withoutAttestation.claims.find((entry) => entry.id === claim.id)?.status, "verified", "attestation removal must remove verification");
  }
}
