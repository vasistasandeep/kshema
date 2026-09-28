import { getAnchor, getPanchanga } from "@/lib/data";
import { notFound } from "next/navigation";
import { AnchorHome } from "@/components/anchor/AnchorHome";

export default async function AnchorHomePage({ params }: { params: { id: string } }) {
  const [a, panchanga] = await Promise.all([getAnchor(params.id), getPanchanga()]);
  if (!a) notFound();
  return <AnchorHome anchor={a} panchanga={panchanga} />;
}
