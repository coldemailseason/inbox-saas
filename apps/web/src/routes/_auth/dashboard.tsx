import { Button } from "@inbox-saas/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { authClient } from "@/lib/auth-client";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/_auth/dashboard")({
  component: RouteComponent,
});

function RouteComponent() {
  const { session, customerState } = Route.useRouteContext();

  const controlPlane = useQuery(orpc.controlPlane.queryOptions());

  const hasProSubscription = (customerState?.activeSubscriptions?.length ?? 0) > 0;

  return (
    <div>
      <h1>Dashboard</h1>
      <p>Welcome {session.data?.user.name}</p>
      <p>
        Organizations:{" "}
        {controlPlane.data
          ? controlPlane.data.organizations.map((organization) => organization.name).join(", ") ||
            "None"
          : ""}
      </p>
      <p>
        Workspaces:{" "}
        {controlPlane.data
          ? controlPlane.data.workspaces.map((workspace) => workspace.name).join(", ") || "None"
          : ""}
      </p>
      <p>Plan: {hasProSubscription ? "Pro" : "Free"}</p>
      {hasProSubscription ? (
        <Button onClick={async () => await authClient.customer.portal()}>
          Manage Subscription
        </Button>
      ) : (
        <Button onClick={async () => await authClient.checkout({ slug: "pro" })}>
          Upgrade to Pro
        </Button>
      )}
    </div>
  );
}
