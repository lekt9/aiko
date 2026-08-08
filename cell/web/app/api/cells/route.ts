import { NextResponse } from "next/server";
import { discoverCells } from "@/lib/cell";
export const dynamic = "force-dynamic";
export async function GET() {
  const cells = discoverCells().map(c => ({
    path: c.path.replace(process.cwd() + "/../", "").replace(process.cwd()+"/",""),
    rel: c.path.replace(process.cwd().replace(/\/web$/,"")+"/",""),
    name: c.name, description: c.description,
    isLeaf: c.isLeaf, run: c.run,
    membrane: c.membrane, organelles: c.organelles, wiring: c.wiring,
  }));
  return NextResponse.json({ cells });
}
