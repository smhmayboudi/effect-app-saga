import { Schema } from "effect"

export const ProductId = Schema.UUID.pipe(
  Schema.brand("ProductId"),
  Schema.annotations({ description: "Product Identification" })
)
export type ProductId = typeof ProductId.Type
