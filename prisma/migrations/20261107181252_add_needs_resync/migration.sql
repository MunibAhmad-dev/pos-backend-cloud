-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "needs_resync" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "admin_payment_records" (
    "id" TEXT NOT NULL,
    "instance_id" TEXT NOT NULL,
    "store_name" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "month" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "recorded_by" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_payment_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_payment_records_month_idx" ON "admin_payment_records"("month");

-- CreateIndex
CREATE INDEX "admin_payment_records_instance_id_idx" ON "admin_payment_records"("instance_id");
