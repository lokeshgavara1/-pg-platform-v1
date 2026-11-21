-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'REPORTED';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "reportedById" TEXT,
ADD COLUMN     "upiRef" TEXT;

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "upiId" TEXT,
ADD COLUMN     "upiPayeeName" TEXT;

