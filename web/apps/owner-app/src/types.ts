export interface Property {
  id: string;
  name: string;
  address: string;
  city: string;
  cityCode: string;
  rentDueDay: number;
  minNoticeDays: number;
  reservationHoldHours: number;
  tokenAmountPaise: number;
  depositMonths: number;
  verificationReminderDays: number;
  remindersEnabled: boolean;
  inviteCode: string;
  status: 'ACTIVE' | 'INACTIVE';
}

export type BedState = 'VACANT' | 'RESERVED' | 'OCCUPIED' | 'INACTIVE';

export interface Bed {
  id: string;
  label: string;
  status: 'ACTIVE' | 'INACTIVE';
  occupancy?: { status: BedState; tenancyId?: string; tenantName?: string; bookingId?: string; bookingStatus?: string; holdUntil?: string };
}

export interface Room {
  id: string;
  name: string;
  floor: number;
  sharingType: number;
  rentPaise: number;
  status: 'ACTIVE' | 'INACTIVE';
  beds: Bed[];
}

export interface InvoiceLine {
  id: string;
  kind: string;
  description: string;
  amountPaise: number;
}

export interface Payment {
  id: string;
  amountPaise: number;
  method: 'CASH' | 'UPI_DIRECT' | 'GATEWAY';
  status: 'CREATED' | 'SUCCESS' | 'FAILED';
  note?: string | null;
  receivedAt?: string | null;
  createdAt: string;
  gatewayLinkUrl?: string | null;
}

export interface Invoice {
  id: string;
  number: string;
  kind: 'RENT' | 'DEPOSIT' | 'TOKEN' | 'OTHER';
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string;
  totalPaise: number;
  paidPaise: number;
  status: 'DUE' | 'PARTIAL' | 'PAID' | 'VOID';
  lines?: InvoiceLine[];
  payments?: Payment[];
  property?: { name: string };
  tenancy?: { id: string; tenantProfile: { user: { name: string; phone?: string } }; bed: { label: string; room: { name: string } } } | null;
  booking?: { id: string; tenantUser: { name: string } } | null;
}

export interface TenancyRow {
  id: string;
  status: 'ACTIVE' | 'NOTICE' | 'ENDED';
  startDate: string;
  endDate: string | null;
  rentPaise: number;
  outstandingPaise: number;
  overduePaise: number;
  property: { id: string; name: string };
  bed: { id: string; label: string; room: { id: string; name: string } };
  tenantProfile: { id: string; kycStatus: string; user: { id: string; name: string; phone: string } };
}
