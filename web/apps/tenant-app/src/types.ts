export interface Home {
  user: { id: string; name: string; phone: string };
  kycStatus: 'NOT_SUBMITTED' | 'PENDING' | 'APPROVED' | 'REJECTED';
  stay: {
    tenancyId: string;
    status: 'ACTIVE' | 'NOTICE';
    propertyName: string;
    propertyAddress: string;
    room: string;
    bed: string;
    startDate: string;
    endDate: string | null;
    rentPaise: number;
    depositPaise: number;
    depositHeldPaise: number;
    rentDueDay: number;
    minNoticeDays: number;
  } | null;
  dues: { outstandingPaise: number; overduePaise: number; nextDueDate: string | null };
  agreement: { id: string; status: 'DRAFT' | 'SIGNED'; signedAt: string | null; esignDevOnly: boolean } | null;
  booking: { id: string; status: 'RESERVED' | 'PAID'; holdUntil: string; moveInDate: string; property: { name: string }; bed: { label: string; room: { name: string } } } | null;
  unreadNotifications: number;
}

export interface Invoice {
  id: string;
  number: string;
  kind: 'RENT' | 'DEPOSIT' | 'TOKEN' | 'OTHER';
  periodStart: string | null;
  dueDate: string;
  totalPaise: number;
  paidPaise: number;
  status: 'DUE' | 'PARTIAL' | 'PAID' | 'VOID';
  lines: { id: string; description: string; amountPaise: number }[];
  property: { name: string };
}
