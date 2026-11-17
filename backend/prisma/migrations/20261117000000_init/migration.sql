-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'TENANT', 'STAFF', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('RESERVED', 'PAID', 'CONVERTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TenancyStatus" AS ENUM ('ACTIVE', 'NOTICE', 'ENDED');

-- CreateEnum
CREATE TYPE "AgreementStatus" AS ENUM ('DRAFT', 'SIGNED', 'VOID');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('RENT', 'DEPOSIT', 'TOKEN', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DUE', 'PARTIAL', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "InvoiceLineKind" AS ENUM ('RENT', 'EXTRA', 'DEPOSIT', 'TOKEN', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'UPI_DIRECT', 'GATEWAY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "DepositEntryType" AS ENUM ('COLLECTED', 'DEDUCTION', 'REFUND');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('NOT_STARTED', 'SUBMITTED', 'ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "MoveOutStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'SETTLEMENT_PROPOSED', 'DISPUTED', 'TENANT_ACCEPTED', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FilePurpose" AS ENUM ('KYC_ID', 'KYC_PHOTO', 'COMPLAINT_PHOTO', 'DEDUCTION_PHOTO', 'AGREEMENT', 'RECEIPT');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('PUSH', 'SMS', 'WHATSAPP');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpRequest" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "cityCode" TEXT NOT NULL,
    "rentDueDay" INTEGER NOT NULL DEFAULT 5,
    "minNoticeDays" INTEGER NOT NULL DEFAULT 30,
    "reservationHoldHours" INTEGER NOT NULL DEFAULT 24,
    "tokenAmountPaise" INTEGER NOT NULL DEFAULT 200000,
    "depositMonths" INTEGER NOT NULL DEFAULT 1,
    "verificationReminderDays" INTEGER NOT NULL DEFAULT 7,
    "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "inviteCode" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyStaff" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyStaff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "floor" INTEGER NOT NULL DEFAULT 0,
    "sharingType" INTEGER NOT NULL,
    "rentPaise" INTEGER NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bed" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "guardianName" TEXT,
    "guardianPhone" TEXT,
    "fatherName" TEXT,
    "permanentAddress" TEXT,
    "occupation" TEXT,
    "workplace" TEXT,
    "idType" TEXT,
    "idLast4" TEXT,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "kycRejectReason" TEXT,
    "kycIdFileId" TEXT,
    "kycPhotoFileId" TEXT,
    "kycSubmittedAt" TIMESTAMP(3),
    "kycReviewedAt" TIMESTAMP(3),
    "kycReviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "bedId" TEXT NOT NULL,
    "tenantUserId" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'RESERVED',
    "holdUntil" TIMESTAMP(3) NOT NULL,
    "moveInDate" DATE NOT NULL,
    "rentPaise" INTEGER NOT NULL,
    "depositPaise" INTEGER NOT NULL,
    "tokenAmountPaise" INTEGER NOT NULL,
    "cancelReason" TEXT,
    "refundDue" BOOLEAN NOT NULL DEFAULT false,
    "tenancyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenancy" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "bedId" TEXT NOT NULL,
    "tenantProfileId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "billingFrom" DATE NOT NULL,
    "endDate" DATE,
    "rentPaise" INTEGER NOT NULL,
    "depositPaise" INTEGER NOT NULL,
    "status" "TenancyStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BedMove" (
    "id" TEXT NOT NULL,
    "tenancyId" TEXT NOT NULL,
    "fromBedId" TEXT NOT NULL,
    "toBedId" TEXT NOT NULL,
    "movedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT NOT NULL,

    CONSTRAINT "BedMove_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringCharge" (
    "id" TEXT NOT NULL,
    "tenancyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agreement" (
    "id" TEXT NOT NULL,
    "tenancyId" TEXT NOT NULL,
    "status" "AgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "pdfFileId" TEXT NOT NULL,
    "signedPdfFileId" TEXT,
    "esignProvider" TEXT,
    "esignDevOnly" BOOLEAN NOT NULL DEFAULT true,
    "signOtpHash" TEXT,
    "signOtpExpiresAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "tenancyId" TEXT,
    "bookingId" TEXT,
    "kind" "InvoiceKind" NOT NULL,
    "periodStart" DATE,
    "periodEnd" DATE,
    "dueDate" DATE NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "paidPaise" INTEGER NOT NULL DEFAULT 0,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DUE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" "InvoiceLineKind" NOT NULL,
    "description" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "provider" TEXT,
    "gatewayLinkId" TEXT,
    "gatewayLinkUrl" TEXT,
    "gatewayPaymentId" TEXT,
    "note" TEXT,
    "recordedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "signatureOk" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositLedger" (
    "id" TEXT NOT NULL,
    "tenancyId" TEXT NOT NULL,
    "type" "DepositEntryType" NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "photoFileId" TEXT,
    "moveOutId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepositLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoveOut" (
    "id" TEXT NOT NULL,
    "tenancyId" TEXT NOT NULL,
    "requestedMoveOutDate" DATE NOT NULL,
    "noticeGivenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "MoveOutStatus" NOT NULL DEFAULT 'REQUESTED',
    "ownerNote" TEXT,
    "checklist" JSONB,
    "depositHeldPaise" INTEGER,
    "deductionsPaise" INTEGER,
    "refundPaise" INTEGER,
    "balanceDuePaise" INTEGER,
    "tenantComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoveOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementDeduction" (
    "id" TEXT NOT NULL,
    "moveOutId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "photoFileId" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementDeduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Complaint" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "tenancyId" TEXT NOT NULL,
    "raisedById" TEXT NOT NULL,
    "assignedToId" TEXT,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "closingNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplaintUpdate" (
    "id" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "fromStatus" "ComplaintStatus",
    "toStatus" "ComplaintStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplaintUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notice" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationRecord" (
    "id" TEXT NOT NULL,
    "tenancyId" TEXT NOT NULL,
    "cityCode" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "submittedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "reference" TEXT,
    "notes" TEXT,
    "lastReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileObject" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "purpose" "FilePurpose" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" "FileStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "complaintId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileAccessLog" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderLog" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "channels" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "OtpRequest_phone_createdAt_idx" ON "OtpRequest"("phone", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Property_inviteCode_key" ON "Property"("inviteCode");

-- CreateIndex
CREATE INDEX "Property_ownerId_idx" ON "Property"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyStaff_propertyId_userId_key" ON "PropertyStaff"("propertyId", "userId");

-- CreateIndex
CREATE INDEX "Room_propertyId_idx" ON "Room"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "Room_propertyId_name_key" ON "Room"("propertyId", "name");

-- CreateIndex
CREATE INDEX "Bed_roomId_idx" ON "Bed"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "Bed_roomId_label_key" ON "Bed"("roomId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "TenantProfile_userId_key" ON "TenantProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantProfile_kycIdFileId_key" ON "TenantProfile"("kycIdFileId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantProfile_kycPhotoFileId_key" ON "TenantProfile"("kycPhotoFileId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_tenancyId_key" ON "Booking"("tenancyId");

-- CreateIndex
CREATE INDEX "Booking_propertyId_status_idx" ON "Booking"("propertyId", "status");

-- CreateIndex
CREATE INDEX "Booking_tenantUserId_idx" ON "Booking"("tenantUserId");

-- CreateIndex
CREATE INDEX "Booking_bedId_idx" ON "Booking"("bedId");

-- CreateIndex
CREATE INDEX "Tenancy_propertyId_status_idx" ON "Tenancy"("propertyId", "status");

-- CreateIndex
CREATE INDEX "Tenancy_tenantProfileId_idx" ON "Tenancy"("tenantProfileId");

-- CreateIndex
CREATE INDEX "Tenancy_bedId_idx" ON "Tenancy"("bedId");

-- CreateIndex
CREATE INDEX "RecurringCharge_tenancyId_idx" ON "RecurringCharge"("tenancyId");

-- CreateIndex
CREATE UNIQUE INDEX "Agreement_pdfFileId_key" ON "Agreement"("pdfFileId");

-- CreateIndex
CREATE UNIQUE INDEX "Agreement_signedPdfFileId_key" ON "Agreement"("signedPdfFileId");

-- CreateIndex
CREATE INDEX "Agreement_tenancyId_idx" ON "Agreement"("tenancyId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE INDEX "Invoice_propertyId_status_idx" ON "Invoice"("propertyId", "status");

-- CreateIndex
CREATE INDEX "Invoice_tenancyId_idx" ON "Invoice"("tenancyId");

-- CreateIndex
CREATE INDEX "Invoice_dueDate_idx" ON "Invoice"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenancyId_kind_periodStart_key" ON "Invoice"("tenancyId", "kind", "periodStart");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_gatewayLinkId_key" ON "Payment"("gatewayLinkId");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_idx" ON "WebhookEvent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");

-- CreateIndex
CREATE INDEX "DepositLedger_tenancyId_idx" ON "DepositLedger"("tenancyId");

-- CreateIndex
CREATE UNIQUE INDEX "MoveOut_tenancyId_key" ON "MoveOut"("tenancyId");

-- CreateIndex
CREATE INDEX "SettlementDeduction_moveOutId_idx" ON "SettlementDeduction"("moveOutId");

-- CreateIndex
CREATE INDEX "Complaint_propertyId_status_idx" ON "Complaint"("propertyId", "status");

-- CreateIndex
CREATE INDEX "Complaint_raisedById_idx" ON "Complaint"("raisedById");

-- CreateIndex
CREATE INDEX "ComplaintUpdate_complaintId_idx" ON "ComplaintUpdate"("complaintId");

-- CreateIndex
CREATE INDEX "Notice_propertyId_status_idx" ON "Notice"("propertyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationRecord_tenancyId_key" ON "VerificationRecord"("tenancyId");

-- CreateIndex
CREATE INDEX "VerificationRecord_status_idx" ON "VerificationRecord"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FileObject_storageKey_key" ON "FileObject"("storageKey");

-- CreateIndex
CREATE INDEX "FileObject_ownerUserId_idx" ON "FileObject"("ownerUserId");

-- CreateIndex
CREATE INDEX "FileAccessLog_fileId_idx" ON "FileAccessLog"("fileId");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderLog_invoiceId_offsetDays_key" ON "ReminderLog"("invoiceId", "offsetDays");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyStaff" ADD CONSTRAINT "PropertyStaff_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyStaff" ADD CONSTRAINT "PropertyStaff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bed" ADD CONSTRAINT "Bed_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantProfile" ADD CONSTRAINT "TenantProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantProfile" ADD CONSTRAINT "TenantProfile_kycIdFileId_fkey" FOREIGN KEY ("kycIdFileId") REFERENCES "FileObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantProfile" ADD CONSTRAINT "TenantProfile_kycPhotoFileId_fkey" FOREIGN KEY ("kycPhotoFileId") REFERENCES "FileObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_bedId_fkey" FOREIGN KEY ("bedId") REFERENCES "Bed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_tenantUserId_fkey" FOREIGN KEY ("tenantUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_bedId_fkey" FOREIGN KEY ("bedId") REFERENCES "Bed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_tenantProfileId_fkey" FOREIGN KEY ("tenantProfileId") REFERENCES "TenantProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BedMove" ADD CONSTRAINT "BedMove_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringCharge" ADD CONSTRAINT "RecurringCharge_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_pdfFileId_fkey" FOREIGN KEY ("pdfFileId") REFERENCES "FileObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_signedPdfFileId_fkey" FOREIGN KEY ("signedPdfFileId") REFERENCES "FileObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositLedger" ADD CONSTRAINT "DepositLedger_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoveOut" ADD CONSTRAINT "MoveOut_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementDeduction" ADD CONSTRAINT "SettlementDeduction_moveOutId_fkey" FOREIGN KEY ("moveOutId") REFERENCES "MoveOut"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintUpdate" ADD CONSTRAINT "ComplaintUpdate_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationRecord" ADD CONSTRAINT "VerificationRecord_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileObject" ADD CONSTRAINT "FileObject_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAccessLog" ADD CONSTRAINT "FileAccessLog_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Double-booking protection (partial unique indexes Prisma cannot express).
-- At most one live booking and one live tenancy per bed. Cross-table conflicts
-- (booking vs tenancy) are prevented by locking the Bed row (SELECT ... FOR UPDATE)
-- inside the same transaction; see src/modules/beds/bedLock.ts.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "booking_one_live_per_bed" ON "Booking" ("bedId") WHERE "status" IN ('RESERVED', 'PAID');
CREATE UNIQUE INDEX "tenancy_one_live_per_bed" ON "Tenancy" ("bedId") WHERE "status" IN ('ACTIVE', 'NOTICE');
-- A tenant can hold only one live tenancy at a time.
CREATE UNIQUE INDEX "tenancy_one_live_per_tenant" ON "Tenancy" ("tenantProfileId") WHERE "status" IN ('ACTIVE', 'NOTICE');
-- Money is never negative.
ALTER TABLE "Invoice" ADD CONSTRAINT "invoice_amounts_nonneg" CHECK ("totalPaise" >= 0 AND "paidPaise" >= 0 AND "paidPaise" <= "totalPaise");
ALTER TABLE "Payment" ADD CONSTRAINT "payment_amount_pos" CHECK ("amountPaise" > 0);
ALTER TABLE "DepositLedger" ADD CONSTRAINT "deposit_amount_pos" CHECK ("amountPaise" > 0);
ALTER TABLE "Property" ADD CONSTRAINT "property_due_day_range" CHECK ("rentDueDay" BETWEEN 1 AND 28);
