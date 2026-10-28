-- AlterTable
ALTER TABLE "repos" ADD COLUMN     "agentAutorunner" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "agentOneAtATime" BOOLEAN NOT NULL DEFAULT false;
