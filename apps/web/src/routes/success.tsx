import { createFileRoute, useSearch } from "@tanstack/react-router";
import { z } from "zod";

const successSearchSchema = z.object({
  checkout_id: z.string().optional(),
});

export const Route = createFileRoute("/success")({
  component: SuccessPage,
  validateSearch: (search) => successSearchSchema.parse(search),
});

function SuccessPage() {
  const { checkout_id } = useSearch({ from: "/success" });

  return (
    <div className="container mx-auto px-4 py-8">
      <h1>Payment Successful!</h1>
      {checkout_id && <p>Checkout ID: {checkout_id}</p>}
    </div>
  );
}
