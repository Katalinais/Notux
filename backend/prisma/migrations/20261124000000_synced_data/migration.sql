-- CreateTable
CREATE TABLE "SyncedData" (
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncedData_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "SyncedData" ADD CONSTRAINT "SyncedData_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
