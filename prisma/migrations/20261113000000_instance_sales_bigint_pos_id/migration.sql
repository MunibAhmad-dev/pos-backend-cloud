-- POS sale ids can exceed INT4 (timestamp-based ids from synced devices); those upserts failed permanently.
ALTER TABLE "instance_sales" ALTER COLUMN "pos_sale_id" SET DATA TYPE BIGINT;
