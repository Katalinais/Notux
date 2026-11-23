-- Username/password sign-in next to Google: Google is no longer the only way in.
ALTER TABLE "User" ALTER COLUMN "googleSub" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "username" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
