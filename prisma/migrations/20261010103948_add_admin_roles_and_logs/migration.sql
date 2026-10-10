-- AlterTable
ALTER TABLE "manufacturing_instances" ADD COLUMN     "password_plain" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "instances" (
    "id" SERIAL NOT NULL,
    "instance_id" TEXT NOT NULL,
    "store_name" TEXT NOT NULL DEFAULT '',
    "owner_name" TEXT NOT NULL DEFAULT '',
    "owner_mobile" TEXT NOT NULL,
    "owner_email" TEXT NOT NULL DEFAULT '',
    "store_address" TEXT NOT NULL DEFAULT '',
    "business_name" TEXT NOT NULL DEFAULT '',
    "api_key" TEXT NOT NULL,
    "license_key" TEXT NOT NULL DEFAULT '',
    "license_plan" TEXT NOT NULL DEFAULT 'none',
    "license_expiry" TEXT,
    "approval_status" TEXT NOT NULL DEFAULT 'pending',
    "block_reason" TEXT NOT NULL DEFAULT '',
    "last_seen" TIMESTAMP(3),
    "app_version" TEXT NOT NULL DEFAULT '',
    "total_sales" INTEGER NOT NULL DEFAULT 0,
    "total_revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_customers" INTEGER NOT NULL DEFAULT 0,
    "total_products" INTEGER NOT NULL DEFAULT 0,
    "device_fingerprint" TEXT NOT NULL DEFAULT '',
    "license_revoked" INTEGER NOT NULL DEFAULT 0,
    "branch_name" TEXT NOT NULL DEFAULT 'Main Branch',
    "operating_mode" TEXT NOT NULL DEFAULT 'full',
    "mobile_access" BOOLEAN NOT NULL DEFAULT false,
    "cloud_blocked" BOOLEAN NOT NULL DEFAULT false,
    "deleted_categories" TEXT NOT NULL DEFAULT '[]',
    "db_upload_status" TEXT NOT NULL DEFAULT 'none',
    "db_upload_note" TEXT NOT NULL DEFAULT '',
    "password_hash" TEXT NOT NULL DEFAULT '',
    "password_plain" TEXT NOT NULL DEFAULT '',
    "parent_instance_id" TEXT NOT NULL DEFAULT '',
    "branch_code" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_events" (
    "id" SERIAL NOT NULL,
    "instance_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instance_sales" (
    "id" SERIAL NOT NULL,
    "instance_id" TEXT NOT NULL,
    "pos_sale_id" INTEGER NOT NULL,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "payment_method" TEXT NOT NULL DEFAULT 'cash',
    "payment_status" TEXT NOT NULL DEFAULT 'Paid',
    "status" TEXT NOT NULL DEFAULT 'Completed',
    "items_count" INTEGER NOT NULL DEFAULT 0,
    "items_summary" TEXT NOT NULL DEFAULT '',
    "date_created" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instance_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_activity_logs" (
    "id" SERIAL NOT NULL,
    "admin_id" INTEGER,
    "admin_name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entity_id" TEXT,
    "detail" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_auth_logs" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_auth_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_keys" (
    "id" SERIAL NOT NULL,
    "license_key" TEXT NOT NULL,
    "instance_id" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'monthly',
    "duration_days" INTEGER NOT NULL DEFAULT 30,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "license_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "target_instance_id" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMP(3),
    "display_type" TEXT NOT NULL DEFAULT 'marquee',
    "style" TEXT DEFAULT 'violet',

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_releases" (
    "id" SERIAL NOT NULL,
    "version" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "changelog" TEXT NOT NULL DEFAULT '',
    "download_url" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL DEFAULT 0,
    "is_mandatory" BOOLEAN NOT NULL DEFAULT false,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" TEXT NOT NULL DEFAULT 'admin',

    CONSTRAINT "app_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_reads" (
    "notification_id" INTEGER NOT NULL,
    "instance_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_reads_pkey" PRIMARY KEY ("notification_id","instance_id")
);

-- CreateTable
CREATE TABLE "manufacturing_sync_events" (
    "id" SERIAL NOT NULL,
    "instance_id" INTEGER NOT NULL,
    "entity_type" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "local_id" INTEGER,
    "payload" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manufacturing_sync_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manufacturing_instance_sales" (
    "id" SERIAL NOT NULL,
    "instance_id" INTEGER NOT NULL,
    "local_sale_id" INTEGER NOT NULL,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paid_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "payment_method" TEXT NOT NULL DEFAULT 'Cash',
    "status" TEXT NOT NULL DEFAULT 'Completed',
    "customer_name" TEXT NOT NULL DEFAULT '',
    "items_count" INTEGER NOT NULL DEFAULT 0,
    "date_created" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manufacturing_instance_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mercy_users" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "cnic" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_plain" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT 'student',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mercy_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mercy_applications" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "father_name" TEXT NOT NULL DEFAULT '',
    "dob" TEXT NOT NULL DEFAULT '',
    "gender" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "qualification" TEXT NOT NULL DEFAULT '',
    "program" TEXT NOT NULL DEFAULT '',
    "marks_matric" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marks_fsc" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "merit_rank" INTEGER,
    "admin_note" TEXT NOT NULL DEFAULT '',
    "cnic_number" TEXT NOT NULL DEFAULT '',
    "cnic_front" TEXT,
    "cnic_back" TEXT,
    "profile_picture" TEXT,
    "domicile_doc" TEXT,
    "matric_docs" TEXT,
    "fsc_docs" TEXT,
    "kmu_cat_doc" TEXT,
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mercy_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mercy_status_logs" (
    "id" SERIAL NOT NULL,
    "application_id" INTEGER NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "admin_note" TEXT NOT NULL DEFAULT '',
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mercy_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_requests" (
    "id" SERIAL NOT NULL,
    "instance_id" TEXT NOT NULL,
    "branch_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "branch_code" TEXT NOT NULL DEFAULT '',
    "branch_id" TEXT NOT NULL DEFAULT '',
    "admin_note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instances_instance_id_key" ON "instances"("instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "instances_api_key_key" ON "instances"("api_key");

-- CreateIndex
CREATE INDEX "instances_approval_status_idx" ON "instances"("approval_status");

-- CreateIndex
CREATE INDEX "instances_last_seen_idx" ON "instances"("last_seen");

-- CreateIndex
CREATE INDEX "sync_events_instance_id_idx" ON "sync_events"("instance_id");

-- CreateIndex
CREATE INDEX "sync_events_entity_type_operation_idx" ON "sync_events"("entity_type", "operation");

-- CreateIndex
CREATE INDEX "instance_sales_instance_id_idx" ON "instance_sales"("instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "instance_sales_instance_id_pos_sale_id_key" ON "instance_sales"("instance_id", "pos_sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- CreateIndex
CREATE INDEX "admin_activity_logs_admin_id_idx" ON "admin_activity_logs"("admin_id");

-- CreateIndex
CREATE INDEX "admin_activity_logs_created_at_idx" ON "admin_activity_logs"("created_at");

-- CreateIndex
CREATE INDEX "admin_auth_logs_created_at_idx" ON "admin_auth_logs"("created_at");

-- CreateIndex
CREATE INDEX "admin_auth_logs_username_idx" ON "admin_auth_logs"("username");

-- CreateIndex
CREATE UNIQUE INDEX "license_keys_license_key_key" ON "license_keys"("license_key");

-- CreateIndex
CREATE INDEX "notifications_target_instance_id_idx" ON "notifications"("target_instance_id");

-- CreateIndex
CREATE INDEX "notifications_is_active_expires_at_idx" ON "notifications"("is_active", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "app_releases_version_key" ON "app_releases"("version");

-- CreateIndex
CREATE INDEX "app_releases_channel_published_idx" ON "app_releases"("channel", "published");

-- CreateIndex
CREATE INDEX "manufacturing_sync_events_instance_id_idx" ON "manufacturing_sync_events"("instance_id");

-- CreateIndex
CREATE INDEX "manufacturing_sync_events_instance_id_entity_type_idx" ON "manufacturing_sync_events"("instance_id", "entity_type");

-- CreateIndex
CREATE INDEX "manufacturing_instance_sales_instance_id_idx" ON "manufacturing_instance_sales"("instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "manufacturing_instance_sales_instance_id_local_sale_id_key" ON "manufacturing_instance_sales"("instance_id", "local_sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "mercy_users_cnic_key" ON "mercy_users"("cnic");

-- CreateIndex
CREATE UNIQUE INDEX "mercy_users_email_key" ON "mercy_users"("email");

-- CreateIndex
CREATE INDEX "mercy_users_email_idx" ON "mercy_users"("email");

-- CreateIndex
CREATE INDEX "mercy_users_cnic_idx" ON "mercy_users"("cnic");

-- CreateIndex
CREATE UNIQUE INDEX "mercy_applications_user_id_key" ON "mercy_applications"("user_id");

-- CreateIndex
CREATE INDEX "mercy_applications_status_idx" ON "mercy_applications"("status");

-- CreateIndex
CREATE INDEX "mercy_applications_program_idx" ON "mercy_applications"("program");

-- CreateIndex
CREATE INDEX "mercy_status_logs_application_id_idx" ON "mercy_status_logs"("application_id");

-- CreateIndex
CREATE INDEX "branch_requests_instance_id_idx" ON "branch_requests"("instance_id");

-- CreateIndex
CREATE INDEX "branch_requests_status_idx" ON "branch_requests"("status");

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances"("instance_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instance_sales" ADD CONSTRAINT "instance_sales_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances"("instance_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_activity_logs" ADD CONSTRAINT "admin_activity_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_auth_logs" ADD CONSTRAINT "admin_auth_logs_username_fkey" FOREIGN KEY ("username") REFERENCES "admin_users"("username") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_keys" ADD CONSTRAINT "license_keys_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances"("instance_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances"("instance_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturing_sync_events" ADD CONSTRAINT "manufacturing_sync_events_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "manufacturing_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturing_instance_sales" ADD CONSTRAINT "manufacturing_instance_sales_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "manufacturing_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mercy_applications" ADD CONSTRAINT "mercy_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "mercy_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mercy_status_logs" ADD CONSTRAINT "mercy_status_logs_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "mercy_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
