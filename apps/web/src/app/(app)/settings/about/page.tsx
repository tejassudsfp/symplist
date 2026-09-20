import { AboutScreen } from "@/features/about/about-screen";

/** Vercel supplies the commit SHA automatically; GitHub builds may supply the same information. */
export default function AboutPage() {
  return <AboutScreen buildSha={process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA} />;
}
