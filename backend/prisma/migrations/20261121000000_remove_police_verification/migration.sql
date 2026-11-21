-- DropForeignKey
ALTER TABLE "VerificationRecord" DROP CONSTRAINT "VerificationRecord_tenancyId_fkey";

-- AlterTable
ALTER TABLE "Property" DROP COLUMN "cityCode",
DROP COLUMN "verificationReminderDays";

-- DropTable
DROP TABLE "VerificationRecord";

-- DropEnum
DROP TYPE "VerificationStatus";

