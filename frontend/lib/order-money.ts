import type { Order } from "@/lib/types";

/** Money actually collected so far. A recurring order has only paid part of its total. */
export function collectedAmount(order: Pick<Order, "paymentStatus" | "total" | "billingMode" | "recurring">): number {
  if (order.paymentStatus === "paid") return order.total;
  if (order.paymentStatus === "partially_paid" && order.recurring) {
    const later = Math.max(0, order.recurring.successfulCycles - 1);
    return order.recurring.dueToday + later * order.recurring.recurringAmount;
  }
  return 0;
}

export function isPayingOrder(order: Pick<Order, "paymentStatus">): boolean {
  return order.paymentStatus === "paid" || order.paymentStatus === "partially_paid";
}
