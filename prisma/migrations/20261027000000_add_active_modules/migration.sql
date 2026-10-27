-- AlterTable: add active_modules column to instances
ALTER TABLE "instances" ADD COLUMN "active_modules" TEXT NOT NULL DEFAULT '';
