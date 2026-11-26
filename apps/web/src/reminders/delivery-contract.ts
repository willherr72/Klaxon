import { makeFunctionReference } from 'convex/server';
import type { Operation, OperationReceipt, Page, PageArgs, Scope } from './reminder-contract';

export type Device = { publicId: string; revision: number; permission: NotificationPermission; active: boolean };
export type DeliveryStatus = { available: boolean; enabled: boolean; grantRevision: number; publicKey?: string; device: Device | null };
export type DeviceArgs = Scope & { deviceId: string };
type Change = Operation & { expectedRevision: number };
type DeviceChange = DeviceArgs & Change;
export type WireSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type DeliveryWrite = { kind: 'setEnabled'; args: Change & { enabled: boolean } } |
  { kind: 'register'; args: DeviceChange & { permission: 'granted'; subscription: WireSubscription } } |
  { kind: 'setPermission'; args: DeviceChange & { permission: NotificationPermission } } | { kind: 'revoke'; args: DeviceChange };

export type DeliveryAttempt = {
  publicId: string; deviceId: string; channel: 'web_push' | 'native'; occurrencePublicId?: string;
  status: 'scheduled' | 'attempted' | 'accepted_by_provider' | 'uncertain' | 'acknowledged' | 'failed' | 'cancelled';
  createdAt: number; acceptedAt?: number; acknowledgedAt?: number;
};

export const deliveryLabels: Record<DeliveryAttempt['status'], string> = {
  scheduled: 'Scheduled', attempted: 'Attempted', accepted_by_provider: 'Accepted by push provider',
  uncertain: 'Delivery unconfirmed', acknowledged: 'Browser reported display', failed: 'Failed', cancelled: 'Cancelled',
};

export const deliveryApi = {
  status: makeFunctionReference<'query', DeviceArgs, DeliveryStatus>('delivery:status'),
  setEnabled: makeFunctionReference<'mutation', Change & { enabled: boolean }, OperationReceipt>('delivery:setEnabled'),
  register: makeFunctionReference<'mutation', DeviceChange & { permission: 'granted'; subscription: WireSubscription }, OperationReceipt>('delivery:register'),
  setPermission: makeFunctionReference<'mutation', DeviceChange & { permission: NotificationPermission }, OperationReceipt>('delivery:setPermission'),
  revoke: makeFunctionReference<'mutation', DeviceChange, OperationReceipt>('delivery:revoke'),
  history: makeFunctionReference<'query', PageArgs, Page<DeliveryAttempt>>('delivery:history'),
  acknowledge: makeFunctionReference<'mutation', DeviceArgs & { attemptPublicId: string }, { acknowledgedAt: number }>('delivery:acknowledge'),
};
