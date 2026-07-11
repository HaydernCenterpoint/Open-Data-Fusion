import { randomUUID } from 'node:crypto';

import type { SharedEvent, SharedEventDelivery } from './shared-event-delivery.js';

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
 * Collaboration fan-out with an optional shared delivery transport. Presence
 * remains process-local and is rebuilt as clients reconnect; committed
 * workspace and membership events can be fanned out through Redis Streams.
 */
export class WorkspaceEventHub {
  private readonly subscriptions = new Map<string, Map<string, Subscription>>();
  private readonly unsubscribeSharedDelivery: (() => void) | undefined;

  constructor(private readonly sharedDelivery?: SharedEventDelivery) {
    this.unsubscribeSharedDelivery = sharedDelivery?.subscribe('workspace-events', (event) => {
      this.receiveSharedEvent(event);
    });
  }

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
    this.publishCommittedEvent('workspace.updated', workspaceId, data);
  }

  publishMembersUpdated(data: WorkspaceMembersUpdatedData): void {
    const subscriptions = this.subscriptions.get(data.workspaceId);
    if (subscriptions && data.change !== 'removed') {
      for (const subscription of subscriptions.values()) {
        if (subscription.member.userId !== data.member.userId) continue;
        subscription.member = data.member;
      }
    }

    const event: WorkspaceEvent<WorkspaceMembersUpdatedData> = {
      id: randomUUID(),
      type: 'members.updated',
      data: { ...data },
    };

    if (this.sharedDelivery) {
      // The transport dispatches locally before writing remotely, so the
      // existing SSE request path remains non-blocking.
      void this.sharedDelivery.publish({
        topic: 'workspace-events',
        eventId: event.id,
        eventType: event.type,
        aggregateType: 'workspace',
        aggregateId: data.workspaceId,
        messageKey: data.workspaceId,
        deduplicationKey: event.id,
        correlationId: event.id,
        payload: event.data as unknown as Record<string, unknown>,
      });
      return;
    }

    this.applyMembersUpdated(event);
  }

  async close(): Promise<void> {
    this.unsubscribeSharedDelivery?.();
    this.subscriptions.clear();
    await this.sharedDelivery?.close();
  }

  private publishCommittedEvent(
    type: Extract<WorkspaceEvent['type'], 'workspace.updated'>,
    workspaceId: string,
    data: Record<string, unknown>,
  ): void {
    const event: WorkspaceEvent = { id: randomUUID(), type, data };
    if (this.sharedDelivery) {
      void this.sharedDelivery.publish({
        topic: 'workspace-events',
        eventId: event.id,
        eventType: event.type,
        aggregateType: 'workspace',
        aggregateId: workspaceId,
        messageKey: workspaceId,
        deduplicationKey: event.id,
        correlationId: event.id,
        payload: event.data,
      });
      return;
    }
    this.broadcast(workspaceId, event);
  }

  private receiveSharedEvent(event: SharedEvent): void {
    if (event.topic !== 'workspace-events') return;
    const workspaceId = typeof event.payload.workspaceId === 'string' ? event.payload.workspaceId : event.aggregateId;
    if (!workspaceId) return;
    if (event.eventType === 'workspace.updated') {
      this.broadcast(workspaceId, {
        id: event.eventId,
        type: 'workspace.updated',
        data: event.payload,
      });
      return;
    }
    if (event.eventType !== 'members.updated') return;
    const member = event.payload.member;
    const change = event.payload.change;
    const actor = event.payload.actor;
    const occurredAt = event.payload.occurredAt;
    if (
      !member || typeof member !== 'object' || Array.isArray(member)
      || (change !== 'added' && change !== 'updated' && change !== 'removed')
      || typeof actor !== 'string' || typeof occurredAt !== 'string'
    ) return;
    const candidate = member as Record<string, unknown>;
    if (
      candidate.workspaceId !== workspaceId
      || typeof candidate.userId !== 'string'
      || typeof candidate.displayName !== 'string'
      || (candidate.role !== 'owner' && candidate.role !== 'editor' && candidate.role !== 'reviewer' && candidate.role !== 'viewer')
    ) return;
    this.applyMembersUpdated({
      id: event.eventId,
      type: 'members.updated',
      data: {
        workspaceId,
        actor,
        change,
        member: candidate as unknown as WorkspaceMember,
        occurredAt,
      },
    });
  }

  private applyMembersUpdated(event: WorkspaceEvent<WorkspaceMembersUpdatedData>): void {
    const data = event.data;
    const subscriptions = this.subscriptions.get(data.workspaceId);
    if (subscriptions && data.change !== 'removed') {
      for (const subscription of subscriptions.values()) {
        if (subscription.member.userId !== data.member.userId) continue;
        subscription.member = data.member;
      }
    }

    this.broadcast(data.workspaceId, event as unknown as WorkspaceEvent);

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
