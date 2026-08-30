import Link from "next/link";

import { PageShell } from "@/components/features/page-shell";
import { EmptyState } from "@/components/ui";

export default function NotFound() {
  return <PageShell description="The requested project, source, or screen does not exist." title="Not found"><EmptyState action={<div className="action-cluster"><Link className="ui-link-button" href="/projects">View projects</Link><Link className="ui-link-button ui-link-button--secondary" href="/">Dashboard</Link></div>} description="Check the address or return to the workspace." title="We could not find that record" /></PageShell>;
}
