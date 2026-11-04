import { Controller, Get, Injectable, Module, Query, Req, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { AuthModule, AuthRequest, Actor, SessionGuard } from './auth';
import { Database } from './database';
import { requireAccess } from './permission-policy';

class AnalyticsQuery { @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(24) months = 12; }

const tashkentToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const num = (v: unknown) => Number(v ?? 0);
const money = (v: unknown) => new Prisma.Decimal(v === null || v === undefined ? 0 : String(v)).toFixed(2);

type MonthRow = {
  month: string; days: number; bed_days: number; occ_days: number; occupied_end: bigint; beds_end: bigint;
  move_ins: bigint; move_outs: bigint; charged: unknown; rent_charged: unknown; collected: unknown; received: unknown;
  due_count: bigint; on_time: bigint; debt: unknown;
};

/**
 * Owner analytics, months in Tashkent time, computed from the ledger and the stays themselves (no extra
 * tables, so it is right from the first day, including history before this feature):
 * occupancy (bed-nights taken out of bed-nights available), move-ins and move-outs, charged vs received,
 * how much of each month's charges is already paid, rent paid on time (by its due date plus grace), debt at
 * each month's end, plus a forecast for next month, income lost to empty beds and a comparison of rooms.
 * A stay occupies its bed from the move-in date up to, not including, the move-out date.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly db: Database) {}

  overview(actor: Actor, months: number) {
    return this.db.$transaction(async tx => {
      await requireAccess(tx, actor, 'FINANCE_VIEW');
      await tx.$queryRaw`SELECT finance_refresh_property(${actor.propertyId}::uuid)`;
      const p = actor.propertyId, today = tashkentToday();
      // beds.created_at is a UTC timestamp without a zone (unlike the money tables), hence AT TIME ZONE 'UTC' first.
      // A bed counts as available from when it was made (or from its earliest stay, for stays entered
      // with an earlier date) until its room is archived.
      const rows = await tx.$queryRaw<MonthRow[]>`
        WITH m AS (
          SELECT gs::date AS ms, (gs + interval '1 month')::date AS me
          FROM generate_series(date_trunc('month', ${today}::date) - (${months - 1} * interval '1 month'), date_trunc('month', ${today}::date), interval '1 month') gs
        ), mc AS (SELECT ms, me, least(me, ${today}::date + 1) AS mcap FROM m),
        beds AS (
          SELECT b.id,
                 least(((b.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tashkent')::date, coalesce((SELECT min(o.move_in_date) FROM occupancies o WHERE o.bed_id = b.id), 'infinity'::date)) AS from_d,
                 coalesce((r.archived_at AT TIME ZONE 'Asia/Tashkent')::date, 'infinity'::date) AS to_d
          FROM beds b JOIN rooms r ON r.id = b.room_id WHERE r.property_id = ${p}::uuid
        ),
        occ AS (SELECT move_in_date AS a, coalesce(move_out_date, 'infinity'::date) AS b FROM occupancies WHERE property_id = ${p}::uuid)
        SELECT to_char(mc.ms, 'YYYY-MM') AS month, (mc.mcap - mc.ms) AS days,
          (SELECT coalesce(sum(greatest(0, least(mc.mcap, beds.to_d) - greatest(mc.ms, beds.from_d))), 0)::int FROM beds) AS bed_days,
          (SELECT coalesce(sum(greatest(0, least(mc.mcap, occ.b) - greatest(mc.ms, occ.a))), 0)::int FROM occ) AS occ_days,
          (SELECT count(*) FROM occ WHERE occ.a <= mc.mcap - 1 AND occ.b > mc.mcap - 1) AS occupied_end,
          (SELECT count(*) FROM beds WHERE beds.from_d <= mc.mcap - 1 AND beds.to_d > mc.mcap - 1) AS beds_end,
          (SELECT count(*) FROM occ WHERE occ.a >= mc.ms AND occ.a < mc.me) AS move_ins,
          (SELECT count(*) FROM occ WHERE occ.b >= mc.ms AND occ.b < mc.me) AS move_outs,
          (SELECT sum(amount) FROM charges WHERE property_id = ${p}::uuid AND billing_period_start >= mc.ms AND billing_period_start < mc.me) AS charged,
          (SELECT sum(amount) FROM charges WHERE property_id = ${p}::uuid AND type = 'RENT' AND billing_period_start >= mc.ms AND billing_period_start < mc.me) AS rent_charged,
          (SELECT sum(paid_amount) FROM charges WHERE property_id = ${p}::uuid AND billing_period_start >= mc.ms AND billing_period_start < mc.me) AS collected,
          (SELECT sum(amount) FROM payments WHERE property_id = ${p}::uuid AND created_at >= (mc.ms::timestamp AT TIME ZONE 'Asia/Tashkent') AND created_at < (mc.me::timestamp AT TIME ZONE 'Asia/Tashkent')) AS received,
          (SELECT count(*) FROM charges c WHERE c.property_id = ${p}::uuid AND c.type = 'RENT' AND c.due_date >= mc.ms AND c.due_date < mc.mcap) AS due_count,
          (SELECT count(*) FROM charges c WHERE c.property_id = ${p}::uuid AND c.type = 'RENT' AND c.due_date >= mc.ms AND c.due_date < mc.mcap
             AND (SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a WHERE a.charge_id = c.id
                  AND a.created_at < ((c.due_date + c.grace_period_days + 1)::timestamp AT TIME ZONE 'Asia/Tashkent')) >= c.amount) AS on_time,
          (SELECT coalesce(sum(greatest(0, x.ch - x.pa)), 0) FROM (
             SELECT (SELECT coalesce(sum(amount), 0) FROM charges WHERE resident_id = r.id AND created_at < least(now(), mc.me::timestamp AT TIME ZONE 'Asia/Tashkent')) AS ch,
                    (SELECT coalesce(sum(amount), 0) FROM payments WHERE resident_id = r.id AND created_at < least(now(), mc.me::timestamp AT TIME ZONE 'Asia/Tashkent')) AS pa
             FROM residents r WHERE r.property_id = ${p}::uuid) x) AS debt
        FROM mc ORDER BY mc.ms`;
      const monthsOut = rows.map(r => ({
        month: r.month, current: r.month === today.slice(0, 7),
        occupancyPct: r.bed_days > 0 ? Math.round(r.occ_days / r.bed_days * 1000) / 10 : null,
        bedsOccupied: num(r.occupied_end), beds: num(r.beds_end), moveIns: num(r.move_ins), moveOuts: num(r.move_outs),
        charged: money(r.charged), rentCharged: money(r.rent_charged), collected: money(r.collected), received: money(r.received),
        collectionPct: num(r.charged) > 0 ? Math.round(num(r.collected) / num(r.charged) * 1000) / 10 : null,
        onTimePct: num(r.due_count) > 0 ? Math.round(num(r.on_time) / num(r.due_count) * 1000) / 10 : null,
        dueCount: num(r.due_count), onTime: num(r.on_time), debt: money(r.debt),
      }));

      // Now: beds, prices, the next month's rent and what empty beds cost each month.
      const nextStart = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 1));
      const [beds, active, closed, endingRows] = await Promise.all([
        tx.bed.count({ where: { room: { propertyId: p, archivedAt: null } } }),
        tx.occupancy.findMany({ where: { propertyId: p, status: 'ACTIVE' }, select: { monthlyPrice: true, moveInDate: true, plan: { select: { plannedEndDate: true } } } }),
        tx.$queryRaw<{ avg: number | null; n: bigint }[]>`SELECT avg(move_out_date - move_in_date)::float AS avg, count(*) AS n FROM occupancies WHERE property_id = ${p}::uuid AND status = 'CLOSED' AND move_out_date IS NOT NULL`,
        tx.$queryRaw<{ n: bigint; amount: unknown }[]>`
          SELECT count(*) AS n, sum(o.monthly_price) AS amount FROM occupancy_plans pl JOIN occupancies o ON o.id = pl.occupancy_id
          WHERE o.property_id = ${p}::uuid AND o.status = 'ACTIVE' AND pl.planned_end_date >= ${today}::date AND pl.planned_end_date <= (${today}::date + 30)`,
      ]);
      const priced = active.filter(o => o.monthlyPrice.gt(0));
      const avgPrice = priced.length ? priced.reduce((s, o) => s.plus(o.monthlyPrice), new Prisma.Decimal(0)).div(priced.length) : new Prisma.Decimal(0);
      // Next month's rent: every current stay that has not planned to end before next month starts.
      const staying = active.filter(o => !o.plan || o.plan.plannedEndDate >= nextStart);
      const forecast = staying.reduce((s, o) => s.plus(o.monthlyPrice), new Prisma.Decimal(0));
      const leaving = active.filter(o => o.plan && o.plan.plannedEndDate < nextStart);
      const free = Math.max(0, beds - active.length);
      const todayD = new Date(`${today}T00:00:00Z`);
      const tenure = active.length ? active.reduce((s, o) => s + (todayD.getTime() - o.moveInDate.getTime()) / 86400000, 0) / active.length : null;

      // Window totals, payment methods, and each room's occupancy and income over the same months.
      const windowStart = `${monthsOut[0].month}-01`;
      const [totals, methods, rooms] = await Promise.all([
        tx.$queryRaw<{ received: unknown; charged: unknown; collected: unknown }[]>`
          SELECT (SELECT sum(amount) FROM payments WHERE property_id = ${p}::uuid AND created_at >= (${windowStart}::date::timestamp AT TIME ZONE 'Asia/Tashkent')) AS received,
                 (SELECT sum(amount) FROM charges WHERE property_id = ${p}::uuid AND billing_period_start >= ${windowStart}::date) AS charged,
                 (SELECT sum(paid_amount) FROM charges WHERE property_id = ${p}::uuid AND billing_period_start >= ${windowStart}::date) AS collected`,
        tx.$queryRaw<{ method: string; amount: unknown; n: bigint }[]>`
          SELECT method::text, sum(amount) AS amount, count(*) AS n FROM payments
          WHERE property_id = ${p}::uuid AND created_at >= (${windowStart}::date::timestamp AT TIME ZONE 'Asia/Tashkent') GROUP BY 1 ORDER BY 2 DESC`,
        tx.$queryRaw<{ id: string; number: string; beds: bigint; occupied: bigint; bed_days: number; occ_days: number; received: unknown }[]>`
          WITH w AS (SELECT ${windowStart}::date AS ws, ${today}::date + 1 AS we)
          SELECT r.id, r.number,
            (SELECT count(*) FROM beds b WHERE b.room_id = r.id) AS beds,
            (SELECT count(*) FROM occupancies o WHERE o.room_id = r.id AND o.status = 'ACTIVE') AS occupied,
            (SELECT coalesce(sum(greatest(0, w.we - greatest(w.ws, least(((b.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tashkent')::date, coalesce((SELECT min(o.move_in_date) FROM occupancies o WHERE o.bed_id = b.id), 'infinity'::date))))), 0)::int FROM beds b, w WHERE b.room_id = r.id) AS bed_days,
            (SELECT coalesce(sum(greatest(0, least(w.we, coalesce(o.move_out_date, 'infinity'::date)) - greatest(w.ws, o.move_in_date))), 0)::int FROM occupancies o, w WHERE o.room_id = r.id) AS occ_days,
            (SELECT sum(a.amount) FROM payment_allocations a JOIN charges c ON c.id = a.charge_id, w
              WHERE c.room_id = r.id AND a.created_at >= (w.ws::timestamp AT TIME ZONE 'Asia/Tashkent')) AS received
          FROM rooms r WHERE r.property_id = ${p}::uuid AND r.archived_at IS NULL ORDER BY r.number`,
      ]);
      const t = totals[0];
      return {
        asOf: new Date().toISOString(), today, months: monthsOut,
        now: {
          beds, occupied: active.length, free, avgPrice: avgPrice.toFixed(2), lostPerMonth: avgPrice.mul(free).toFixed(2),
          forecast: { month: nextStart.toISOString().slice(0, 7), rent: forecast.toFixed(2), staying: staying.length, leaving: leaving.length,
            leavingRent: leaving.reduce((s, o) => s.plus(o.monthlyPrice), new Prisma.Decimal(0)).toFixed(2) },
          endingIn30Days: { residents: num(endingRows[0]?.n), rent: money(endingRows[0]?.amount) },
          avgStayDays: closed[0]?.avg === null || closed[0]?.avg === undefined ? null : Math.round(closed[0].avg), closedStays: num(closed[0]?.n),
          avgTenureDays: tenure === null ? null : Math.round(tenure),
        },
        window: {
          from: windowStart, received: money(t.received), charged: money(t.charged), collected: money(t.collected),
          collectionPct: num(t.charged) > 0 ? Math.round(num(t.collected) / num(t.charged) * 1000) / 10 : null,
          methods: methods.map(x => ({ method: x.method, amount: money(x.amount), count: num(x.n) })),
        },
        rooms: rooms.map(r => ({ id: r.id, number: r.number, beds: num(r.beds), occupied: num(r.occupied),
          occupancyPct: r.bed_days > 0 ? Math.round(r.occ_days / r.bed_days * 1000) / 10 : null, received: money(r.received) }))
          .sort((a, b) => Number(b.received) - Number(a.received) || a.number.localeCompare(b.number, 'ru', { numeric: true })),
      };
    }, { maxWait: 10000, timeout: 20000 });
  }
}

@Controller('analytics') @UseGuards(SessionGuard)
class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}
  @Get() overview(@Req() req: AuthRequest, @Query() q: AnalyticsQuery) { return this.service.overview(req.actor, q.months); }
}

@Module({ imports: [AuthModule], providers: [AnalyticsService], controllers: [AnalyticsController] })
export class AnalyticsModule {}
