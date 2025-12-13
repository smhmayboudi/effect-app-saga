import { Schema } from "effect"
import { ProductId } from "./Product.js"

export const InventorySchema = Schema.Struct({
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  reservedQuantity: Schema.Number.annotations({ description: "Reserved Quantity" }), // default: 0,
  createdAt: Schema.Date.annotations({ description: "Created At" }), // default: Date.now
  updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "Inventory", identifier: "Inventory" })
)
export type ServiceSchema = typeof InventorySchema.Type

export class Inventory extends Schema.Class<Inventory>("Inventory")(InventorySchema) {
  static decodeUnknown = Schema.decodeUnknown(Inventory)
}
