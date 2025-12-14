import { Schema } from "effect"
import { CustomerId } from "./Customer.js"
import { IdempotencyKey } from "./IdempotencyKey.js"
import { OrderId } from "./Order.js"
import { SagaLogId } from "./SagaLog.js"

export const ShipmentId = Schema.UUID.pipe(
  Schema.brand("ShipmentId"),
  Schema.annotations({ description: "Shipment Identification" })
)
export type ShipmentId = typeof ShipmentId.Type

export const ShipmentSchema = Schema.Struct({
  shipmentId: ShipmentId,
  idempotencyKey: IdempotencyKey,
  orderId: OrderId,
  customerId: CustomerId,
  status: Schema.optionalWith(
    Schema.Literal("PENDING", "SHIPPED", "DELIVERED", "CANCELLED"),
    { default: () => "PENDING" }
  ).annotations({ description: "Status" }),
  sagaLogId: SagaLogId
  // createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" }),
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "Shipment", identifier: "Shipment" })
)
export type ServiceSchema = typeof ShipmentSchema.Type

export class Shipment extends Schema.Class<Shipment>("Shipment")(ShipmentSchema) {
  static decodeUnknown = Schema.decodeUnknown(Shipment)
}
