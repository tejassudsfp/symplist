import type { Metadata } from "next";
import { HomeScreen } from "@/features/marketing/home-screen";

export const metadata: Metadata = {
  title: "Symplist — a calm task workspace",
  description:
    "Three lists, and one real Markdown document with Git history behind every task. Open source, free, and it runs no assistant of its own.",
};

/** The public homepage. The workspace itself lives at /now. */
export default function HomePage() {
  return <HomeScreen />;
}
