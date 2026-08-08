import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
export const dynamic = "force-dynamic";
export async function GET() {
  const db = getDb();
  return NextResponse.json({ firings: db.firings(), orders: db.orders() });
}
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const db = getDb();
  if (body.order) db.upsertOrder(body.order.id ?? `ord-${Date.now()}`, body.order);
  return NextResponse.json({ ok: true });
}
