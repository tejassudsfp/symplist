import { OnboardingConnections } from "@/features/access/onboarding/connections-step";
import { ServiceConnections } from "@/features/connections/service-connections";

export default function ConnectYourToolsPage() {
  return <OnboardingConnections catalogue={<ServiceConnections compact />} />;
}
