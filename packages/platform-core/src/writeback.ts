import type { WritebackRequest, WritebackRisk } from "@open-data-fusion/contracts";

const riskLevel: Record<WritebackRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface WritebackSafetyPolicy {
  enabled: boolean;
  allowedOperations: readonly string[];
  maximumRisk: WritebackRisk;
  requireDryRun: boolean;
  approvalRequirements?: Partial<Record<WritebackRisk, number>>;
}

export interface WritebackSafetyDecision {
  allowed: boolean;
  requiredApprovals: number;
  validApprovals: number;
  reasons: string[];
}

export function evaluateWritebackSafety(request: WritebackRequest, policy: WritebackSafetyPolicy): WritebackSafetyDecision {
  const reasons: string[] = [];
  if (!policy.enabled) reasons.push("Industrial write-back is disabled");
  if (request.state !== "pending_approval" && request.state !== "approved") reasons.push("Request is not awaiting or holding approval");
  if (!policy.allowedOperations.includes(request.operation)) reasons.push(`Operation '${request.operation}' is not allowlisted`);
  if (riskLevel[request.risk] > riskLevel[policy.maximumRisk]) reasons.push(`Risk '${request.risk}' exceeds policy maximum '${policy.maximumRisk}'`);
  if (request.risk === "critical") reasons.push("Critical write-back requires an external safety case and cannot be approved automatically");
  if (policy.requireDryRun && request.dryRunResult?.safe !== true) reasons.push("A successful safe dry-run is required");
  if (request.approvals.some((approval) => approval.decision === "rejected")) reasons.push("At least one reviewer rejected the request");

  const defaultRequired: Record<WritebackRisk, number> = { low: 1, medium: 1, high: 2, critical: 2 };
  const requiredApprovals = policy.approvalRequirements?.[request.risk] ?? defaultRequired[request.risk];
  const validApprovers = new Set(
    request.approvals
      .filter((approval) => approval.decision === "approved" && approval.actor !== request.requestedBy)
      .map((approval) => approval.actor),
  );
  if (validApprovers.size < requiredApprovals) reasons.push(`${requiredApprovals} distinct non-requester approval(s) required`);

  return { allowed: reasons.length === 0, requiredApprovals, validApprovals: validApprovers.size, reasons };
}
