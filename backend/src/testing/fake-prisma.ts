// In-memory stand-in for the parts of PrismaClient that the token services use,
// so their logic can be unit-tested without a database. Test-only (excluded from the build).
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';

type Row = { id: string } & Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { gt?: Date; lt?: Date };
      if (c.gt !== undefined && !((value as Date) > c.gt)) return false;
      if (c.lt !== undefined && !((value as Date) < c.lt)) return false;
      return true;
    }
    if (cond === null) return value === null || value === undefined;
    return value instanceof Date && cond instanceof Date ? value.getTime() === cond.getTime() : value === cond;
  });
}

class FakeModel {
  rows: Row[] = [];

  constructor(private readonly defaults: Record<string, unknown>) {}

  create({ data }: { data: Record<string, unknown> }): Promise<Row> {
    if ('hash' in data && this.rows.some((r) => r.hash === data.hash)) {
      return Promise.reject(new Error('Unique constraint: hash'));
    }
    const row: Row = { id: randomUUID(), createdAt: new Date(), ...this.defaults, ...data };
    this.rows.push(row);
    return Promise.resolve({ ...row });
  }

  findUnique({ where }: { where: Where }): Promise<Row | null> {
    const row = this.rows.find((r) => matches(r, where));
    return Promise.resolve(row ? { ...row } : null);
  }

  updateMany({ where, data }: { where: Where; data: Record<string, unknown> }): Promise<{ count: number }> {
    const hits = this.rows.filter((r) => matches(r, where));
    hits.forEach((r) => Object.assign(r, data));
    return Promise.resolve({ count: hits.length });
  }

  update({ where, data }: { where: Where; data: Record<string, unknown> }): Promise<Row> {
    const row = this.rows.find((r) => matches(r, where));
    if (!row) return Promise.reject(new Error('Record not found'));
    Object.assign(row, data);
    return Promise.resolve({ ...row });
  }

  deleteMany({ where }: { where: Where }): Promise<{ count: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, where));
    return Promise.resolve({ count: before - this.rows.length });
  }
}

export class FakePrisma {
  refreshToken = new FakeModel({ revokedAt: null, replacedById: null });
  loginCode = new FakeModel({ usedAt: null });

  $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  asService(): PrismaService {
    return this as unknown as PrismaService;
  }
}
