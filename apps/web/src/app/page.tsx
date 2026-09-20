import { redirect } from "next/navigation";

/** The application opens in the task workspace, never a dashboard (overall.md). */
export default function HomePage(): never {
  redirect("/now");
}
