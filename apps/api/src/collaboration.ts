import { randomUUID } from 'node:crypto';

export type WorkspaceRole = 'owner' | 'editor' | 'reviewer' | 'viewer';

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  displayName: string;
  role: WorkspaceRole;
}

export type WorkspaceMemberChange = 'added' | 'updated' | 'removed';

export interface WorkspaceMembersUpdatedData {
  workspaceId: string;
  actor: string;
  change: WorkspaceMemberChange;
  member: WorkspaceMember;
  occurredAt: string;
}

export interface WorkspaceEvent<TData = Record<string, unknown>> {
  id: string;
  type: 'workspace.updated' | 'presence.updated' | 'members.updated';
  data: TData;
}

type WorkspaceEventListener = (event: WorkspaceEvent) => void;

interface Subscription {
  member: WorkspaceMember;
  listener: WorkspaceEventListener;
}

/**
 * Process-local collaboration fan-out. Workspaces and revisions remain durable in
 * SQLite; live presence is deliberately ephemeral and is rebuilt as clients
 * reconnect.
 */
export class WorkspaceEventHub {
  private readonly subscriptions = new Map<string, Map<string, Subscription>>();

  subscribe(workspaceId: string, member: WorkspaceMember, listener: WorkspaceEventListener): () => void {
    const workspaceSubscriptions = this.subscriptions.get(workspaceId) ?? new Map<string, Subscription>();
    const subscriptionId = randomUUID();
    workspaceSubscriptions.set(subscriptionId, { member, listener });
    this.subscriptions.set(workspaceId, workspaceSubscriptions);
    this.publishPresence(workspaceId);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const subscriptions = this.subscriptions.get(workspaceId);
      subscriptions?.delete(subscriptionId);
      if (!subscriptions || subscriptions.size === 0) {
        this.subscriptions.delete(workspaceId);
        return;
      }
      this.publishPresence(workspaceId);
    };
  }

  publishWorkspaceUpdated(data: Record<string, unknown>): void {
    const workspaceId = String(data.workspaceId);
    this.broadcast(workspaceId, {
      id: randomUUID(),
      type: 'workspace.updated',
      data,
    });
  }

  publishMembersUpdated(data: WorkspaceMembersUpdatedData): void {
    const subscriptions = this.subscriptions.get(data.workspaceId);
    if (subscriptions && data.change !== 'removed') {
      for (const subscription of subscriptions.values()) {
        if (subscription.member.userId !== data.member.userId) continue;
        subscription.member = data.member;
      }
    }

    this.broadcast(data.workspaceId, {
      id: randomUUID(),
      type: 'members.updated',
      data: { ...data },
    });

    // Deliver the revocation event to the affected client before removing its
    // subscription, so the UI can immediately drop local editing capability.
    if (subscriptions && data.change === 'removed') {
      for (const [subscriptionId, subscription] of subscriptions) {
        if (subscription.member.userId === data.member.userId) subscriptions.delete(subscriptionId);
      }
    }
    this.publishPresence(data.workspaceId);
  }

  private publishPresence(workspaceId: string): void {
    const subscriptions = this.subscriptions.get(workspaceId);
    if (!subscriptions) return;

    const membersById = new Map<string, WorkspaceMember>();
    for (const { member } of subscriptions.values()) membersById.set(member.userId, member);
    const users = [...membersById.values()].sort((left, right) => left.userId.localeCompare(right.userId));
    this.broadcast(workspaceId, {
      id: randomUUID(),
      type: 'presence.updated',
      data: { workspaceId, users, occurredAt: new Date().toISOString() },
    });
  }

  private broadcast(workspaceId: string, event: WorkspaceEvent): void {
    const subscriptions = this.subscriptions.get(workspaceId);
    if (!subscriptions) return;
    for (const [subscriptionId, { listener }] of subscriptions) {
      try {
        listener(event);
      } catch {
        // A disconnected SSE client must never turn a committed workspace write
        // into an HTTP failure for the author of that write.
        subscriptions.delete(subscriptionId);
      }
    }
    if (subscriptions.size === 0) this.subscriptions.delete(workspaceId);
  }
}
