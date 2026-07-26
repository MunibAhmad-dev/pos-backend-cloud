-- CreateTable
CREATE TABLE "manufacturing_instances" (
    "id" SERIAL NOT NULL,
    "mobile" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "company_name" TEXT NOT NULL DEFAULT '',
    "api_key" TEXT NOT NULL,
    "device_fingerprint" TEXT NOT NULL DEFAULT '',
    "license_plan" TEXT NOT NULL DEFAULT 'none',
    "license_expiry" TEXT,
    "trial_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approval_status" TEXT NOT NULL DEFAULT 'pending',
    "app_version" TEXT NOT NULL DEFAULT '',
    "last_seen" TIMESTAMP(3),
    "total_sales" INTEGER NOT NULL DEFAULT 0,
    "total_revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_products" INTEGER NOT NULL DEFAULT 0,
    "total_parts" INTEGER NOT NULL DEFAULT 0,
    "low_stock_items" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manufacturing_instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "manufacturing_instances_mobile_key" ON "manufacturing_instances"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "manufacturing_instances_api_key_key" ON "manufacturing_instances"("api_key");
