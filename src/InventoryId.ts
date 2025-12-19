import { Schema } from "effect"

export const InventoryId = Schema.UUID.pipe(
  Schema.brand("InventoryId"),
  Schema.annotations({ description: "Inventory Identification" })
)
export type InventoryId = typeof InventoryId.Type
