import { Schema } from "effect"
import { CustomerId } from "./Customer.js"
import { ProductId } from "./Product.js"
import { SagaLogId } from "./SagaLog.js"

export const OrderId = Schema.UUID.pipe(
  Schema.brand("OrderId"),
  Schema.annotations({ description: "Order Identification" })
)
export type OrderId = typeof OrderId.Type

export const OrderSchema = Schema.Struct({
  orderId: OrderId,
  customerId: CustomerId,
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  totalPrice: Schema.Number.annotations({ description: "Total Price" }),
  status: Schema.optionalWith(
    Schema.Literal("PENDING", "CONFIRMED", "FAILED", "COMPENSATED").annotations({ description: "Status" }),
    { default: () => "PENDING" }
  ),
  sagaLogId: SagaLogId
  // createdAt: Schema.optionalWith(Schema.Date.annotations({ description: "Created At" }), { default: () => new Date() }),
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "Order", identifier: "Order" })
)
export type ServiceSchema = typeof OrderSchema.Type

export class Order extends Schema.Class<Order>("Order")(OrderSchema) {
  static decodeUnknown = Schema.decodeUnknown(Order)
}
