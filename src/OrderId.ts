import { Schema } from "effect"

export const OrderId = Schema.UUID.pipe(
  Schema.brand("OrderId"),
  Schema.annotations({ description: "Order Identification" })
)
export type OrderId = typeof OrderId.Type
