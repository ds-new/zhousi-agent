import { createHash } from 'node:crypto';
import type { McpBinding } from '@diy-agent/domain';

export interface ApprovalScope { tenantId:string; workspaceId:string; sessionId:string; requestId:string; approvalId:string }
export interface ToolApproval {
  id:string; toolName:string; arguments:Record<string,unknown>; bindingHash:string;
  profileId:string; profileVersionId:string; snapshotHash:string; expiresAt:Date;
  status:'pending'|'approved'|'denied'|'consumed';
  reviewer?:string; reviewedAt?:Date;
}
export function bindingHash(binding:McpBinding, toolName:string, schema:unknown):string {
  return createHash('sha256').update(JSON.stringify([binding,toolName,schema])).digest('hex');
}
export function snapshotHash(snapshot:unknown):string { return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); }
export function approvalScope(input:ApprovalScope):string[] { return [input.tenantId,input.workspaceId,input.sessionId,input.requestId,input.approvalId]; }
