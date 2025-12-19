import { Schema } from "effect"

export const CustomerId = Schema.UUID.pipe(
  Schema.brand("CustomerId"),
  Schema.annotations({ description: "Customer Identification" })
)
export type CustomerId = typeof CustomerId.Type
